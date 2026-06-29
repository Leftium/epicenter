/**
 * The per-channel bridge: turn ONE relay channel (its `channel_data` / `_reset`
 * frames) into a {@link ByteChannel}, the Web Streams duplex the rest of the
 * system speaks.
 *
 * It is the piece both ends of the floor share. The client transport
 * ({@link ./transport}) wraps an accepted channel in one of these and hands the
 * {@link ByteChannel} to the MCP client; the device acceptor ({@link ./acceptor})
 * wraps an admitted channel in one and pipes it to the route target. Neither side
 * parses the bytes: this is the dumb pipe, the same role iroh's bi-stream adapter
 * plays for the native path.
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
 * Outbound (the `sink`): each chunk becomes a `channel_data` frame; closing or
 * aborting the writable (the MCP transport closing the session) emits the
 * terminal `channel_reset` exactly once.
 *
 * Inbound (the `source`): a `channel_data` enqueues bytes (malformed base64 is a
 * controlled `protocol_error` reset, never a thrown crash); a `channel_reset`
 * ends the source, cleanly for `closed` and with an error otherwise so an
 * in-flight MCP read rejects.
 */
export function createChannelBridge(
	options: ChannelBridgeOptions,
): ChannelBridge {
	const { id, send, onTeardown } = options;

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
		write(chunk) {
			send({ type: 'channel_data', id, bytes: bytesToBase64(chunk) });
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
