/**
 * The per-channel bridge: turn ONE relay channel (its `channel_data` / `_reset`
 * frames) into a {@link ByteChannel}, the Web Streams duplex the rest of the
 * system speaks.
 *
 * It is the piece both ends of the floor share. The client transport
 * ({@link ./transport}) wraps an accepted channel in one of these and hands the
 * {@link ByteChannel} to the MCP client; the device acceptor ({@link ./acceptor})
 * wraps an admitted channel in one and pipes it to the route target. Neither side
 * parses the bytes: this is the dumb pipe that carries them, slicing a large
 * write into bounded frames but never reading them.
 *
 * Terminal flow is RESET-ONLY (there is no half-close `channel_end`): the one
 * consumer, an MCP session, only ever "closes the session", so a single
 * `channel_reset` carries the terminal signal in BOTH directions, with `closed`
 * meaning a clean end and any other code meaning an error. Reset-only is also
 * what keeps teardown deterministic: closing the writable always emits the reset
 * (it does not depend on `ReadableStream.cancel()` firing, which Web Streams skip
 * when the source is already closed), so no relay/peer channel entry lingers.
 *
 * Confidentiality and integrity from the relay are NOT provided here: a
 * compromised relay can read, drop, mutate, or inject channel bytes. That is the
 * accepted model (ADR-0004 trusts the relay with plaintext); the auth boundary on
 * a tool call is the device endpoint's own bearer check (the spec's "the endpoint
 * is the boundary, never the relay"), and privacy from Epicenter is self-host
 * (ADR-0068), never the wire.
 *
 * Browser-safe: Web Streams plus `btoa`/`atob`, no node builtin.
 */

import type { ByteChannel } from '../peer-transport.js';
import type {
	ChannelDataFrame,
	ChannelFrame,
	ChannelResetCode,
	ChannelResetFrame,
} from './protocol.js';

/**
 * Cap on the raw bytes one outbound `channel_data` frame carries. A larger
 * `sink.write` is sliced into this many bytes per frame (a byte stream always
 * splits cleanly). Sized so the base64-inflated frame (~1.33x) plus its small
 * JSON envelope stays far under the relay's `MAX_PAYLOAD_BYTES` wire ceiling
 * (5 MiB in `packages/server`), the limit that would otherwise close the shared
 * account-room socket with 1009 and take Yjs sync down as collateral.
 */
const MAX_OUTBOUND_CHUNK_BYTES = 64 * 1024;

/**
 * How many outbound bytes `sink.write` hands the socket before it yields the
 * event loop and lets `write` pend. The pend IS the backpressure the already
 * awaiting MCP writer (`mcp-stream-transport.send`) needs: without it the sink
 * resolves instantly and a fast producer pins unbounded bytes in the socket's
 * send buffer. A small multiple of the per-frame cap: enough to pipeline a few
 * frames per turn, low enough to bound the per-turn burst. This is a soft
 * per-turn rate limit, not a hard cap on the socket buffer: the real drain
 * signal (`bufferedAmount`) is not reachable through the fire-and-forget port.
 */
const OUTBOUND_HIGH_WATER_MARK_BYTES = 512 * 1024;

/**
 * Ceiling on the raw bytes one inbound `channel_data` frame may carry. A frame
 * past it (a peer or a compromised relay sending more than our own framing ever
 * emits) is reset `too_large` instead of being decoded and buffered, so one
 * oversized frame cannot pin memory on the receiver. Generous over our own
 * outbound cap to tolerate a differently-tuned peer, still well under the wire
 * ceiling.
 */
const MAX_INBOUND_CHUNK_BYTES = 1024 * 1024;

/**
 * The base64 string length that {@link MAX_INBOUND_CHUNK_BYTES} raw bytes encode
 * to (3 raw bytes -> 4 chars). Checking the frame's base64 length against this
 * rejects an oversized frame BEFORE `atob` allocates its decoded buffer.
 */
const MAX_INBOUND_BASE64_CHARS = Math.ceil(MAX_INBOUND_CHUNK_BYTES / 3) * 4;

/** Yield a macrotask so the socket's send pump can flush before the next burst. */
const yieldToEventLoop = (): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, 0);
	});

/** Encode raw bytes as the base64 string a `channel_data` frame carries. */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** Decode a `channel_data` frame's base64 string back to raw bytes; throws on malformed input. */
export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Inbound frames a bridge consumes for its channel (data plus the terminal reset). */
type InboundFrame = ChannelDataFrame | ChannelResetFrame;

/** A live channel as a {@link ByteChannel}, plus the inbound-frame feed. */
export type ChannelBridge = {
	/** The byte duplex the MCP transport (or a route pipe) rides. */
	channel: ByteChannel;
	/** Feed one inbound frame the relay delivered for this channel id. */
	handleInbound(frame: InboundFrame): void;
};

export type ChannelBridgeOptions = {
	/** This channel's correlation id, stamped onto every outbound frame. */
	id: string;
	/** Emit an outbound frame for this channel over the account-room socket. */
	send(frame: ChannelFrame): void;
	/** Called once when the channel is fully done (either side's close). */
	onTeardown?(): void;
};

/**
 * Bridge one channel id to a {@link ByteChannel}.
 *
 * Outbound (the `sink`): each chunk is sliced to a frame-size cap and emitted as
 * one or more `channel_data` frames (a byte stream splits cleanly), so no single
 * frame approaches the relay's wire ceiling and takes the shared socket down with
 * a 1009; past a high-water mark `write` pends on a macrotask so a fast producer
 * feels backpressure instead of pinning unbounded bytes in the socket buffer.
 * Closing or aborting the writable (the MCP transport closing the session) emits
 * the terminal `channel_reset` exactly once.
 *
 * Inbound (the `source`): a `channel_data` enqueues bytes (an oversized frame is
 * a controlled `too_large` reset and malformed base64 a `protocol_error` reset,
 * never a thrown crash); a `channel_reset` ends the source, cleanly for `closed`
 * and with an error otherwise so an in-flight MCP read rejects.
 */
export function createChannelBridge(
	options: ChannelBridgeOptions,
): ChannelBridge {
	const { id, send, onTeardown } = options;

	// Outbound bytes handed to `send` since the last event-loop yield. Crossing
	// the high-water mark makes `sink.write` pend, the backpressure signal.
	let queuedBytes = 0;

	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let sourceEnded = false;
	const endSource = (error?: Error) => {
		if (sourceEnded) return;
		sourceEnded = true;
		try {
			if (error) controller?.error(error);
			else controller?.close();
		} catch {
			/* already closed */
		}
	};

	// One terminal transition wins, whichever side fires first.
	let closed = false;
	/** We are closing: tell the peer with a reset, end our source, tear down. */
	const localClose = (code: ChannelResetCode) => {
		if (closed) return;
		closed = true;
		send({ type: 'channel_reset', id, code });
		endSource(code === 'closed' ? undefined : new Error(`channel ${code}`));
		onTeardown?.();
	};
	/** The peer closed (its reset reached us): end our source, tear down, no echo. */
	const remoteClose = (frame: ChannelResetFrame) => {
		if (closed) return;
		closed = true;
		endSource(
			frame.code === 'closed'
				? undefined
				: new Error(
						`channel reset: ${frame.code}${frame.reason ? ` (${frame.reason})` : ''}`,
					),
		);
		onTeardown?.();
	};

	const source = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
		// The consumer (the MCP transport's close cancels its reader) is done.
		cancel() {
			localClose('closed');
		},
	});

	const sink = new WritableStream<Uint8Array>({
		// Slice each chunk to the per-frame cap so no `channel_data` frame approaches
		// the relay's 5 MiB wire ceiling and takes the shared sync socket down with a
		// 1009. Past the high-water mark `write` pends on a macrotask: real
		// backpressure the awaiting MCP writer feels, instead of a fire-and-forget
		// that lets a fast producer pin unbounded bytes in the socket buffer. The
		// `closed` guard before each send stops the loop from emitting data frames
		// after an inbound reset or abort flipped teardown during the yield.
		async write(chunk) {
			for (
				let offset = 0;
				offset < chunk.byteLength;
				offset += MAX_OUTBOUND_CHUNK_BYTES
			) {
				if (closed) return;
				const slice = chunk.subarray(offset, offset + MAX_OUTBOUND_CHUNK_BYTES);
				send({ type: 'channel_data', id, bytes: bytesToBase64(slice) });
				queuedBytes += slice.byteLength;
				if (queuedBytes >= OUTBOUND_HIGH_WATER_MARK_BYTES) {
					queuedBytes = 0;
					await yieldToEventLoop();
				}
			}
		},
		// The MCP transport's close closes the writer; this always fires on close,
		// so the terminal reset is deterministic.
		close() {
			localClose('closed');
		},
		abort() {
			localClose('cancelled');
		},
	});

	return {
		channel: { source, sink },
		handleInbound(frame) {
			if (frame.type === 'channel_data') {
				if (sourceEnded) return;
				// Receive ceiling: a frame carrying more than our framing ever emits (a
				// peer or a compromised relay) is reset `too_large`, not decoded and
				// buffered. Check the base64 length first so an oversized frame is
				// refused before `atob` allocates its decoded buffer.
				if (frame.bytes.length > MAX_INBOUND_BASE64_CHARS) {
					localClose('too_large');
					return;
				}
				let bytes: Uint8Array;
				try {
					bytes = base64ToBytes(frame.bytes);
				} catch {
					// Malformed payload from a peer or a compromised relay: a controlled
					// reset, never a thrown crash through the frame listener.
					localClose('protocol_error');
					return;
				}
				controller?.enqueue(bytes);
				return;
			}
			remoteClose(frame);
		},
	};
}
