/**
 * The per-channel bridge: turn ONE relay channel (its `channel_data` / `_end` /
 * `_reset` frames) into a {@link ByteChannel}, the Web Streams duplex the rest of
 * the system speaks.
 *
 * It is the piece both ends of the floor share. The client transport
 * ({@link ./transport}) wraps an accepted channel in one of these and hands the
 * {@link ByteChannel} to the MCP client; the device acceptor ({@link ./acceptor})
 * wraps an admitted channel in one and pipes it to the route target. Neither side
 * parses the bytes: this is the dumb pipe, the same role iroh's bi-stream adapter
 * plays for the native path.
 *
 * Browser-safe: Web Streams plus `btoa`/`atob`, no node builtin.
 */

import { once } from '../shared/once.js';
import type { ByteChannel } from '../peer-transport.js';
import type {
	ChannelDataFrame,
	ChannelEndFrame,
	ChannelFrame,
	ChannelResetFrame,
} from './protocol.js';

/** Encode raw bytes as the base64 string a `channel_data` frame carries. */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** Decode a `channel_data` frame's base64 string back to raw bytes. */
export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Inbound frames a bridge consumes for its channel (everything but the open/accept). */
type InboundFrame = ChannelDataFrame | ChannelEndFrame | ChannelResetFrame;

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
	/** Called once when the channel is fully done (reset, abort, or reader close). */
	onTeardown?(): void;
};

/**
 * Bridge one channel id to a {@link ByteChannel}.
 *
 * Outbound (the `sink`): each chunk becomes a `channel_data` frame; a clean
 * `close` (the MCP transport half-closing its send side) becomes `channel_end`;
 * an `abort` becomes `channel_reset { cancelled }`. When the consumer cancels the
 * `source` (the MCP transport's final `close`), the whole channel is done, so a
 * `channel_reset { closed }` tells the relay to drop its entry.
 *
 * Inbound (the `source`): a `channel_data` enqueues bytes, a `channel_end`
 * closes the source cleanly (EOF), and a `channel_reset` errors it so the MCP
 * request in flight rejects, then tears down.
 */
export function createChannelBridge(
	options: ChannelBridgeOptions,
): ChannelBridge {
	const { id, send, onTeardown } = options;
	const teardown = once(() => onTeardown?.());

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

	const source = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
		cancel() {
			// The consumer is done with the whole channel (the MCP transport's final
			// close cancels its reader). Tell the relay so it frees the channel entry.
			send({ type: 'channel_reset', id, code: 'closed' });
			teardown();
		},
	});

	const sink = new WritableStream<Uint8Array>({
		write(chunk) {
			send({ type: 'channel_data', id, bytes: bytesToBase64(chunk) });
		},
		close() {
			// Half-close: this side will write no more, but the peer may still answer.
			send({ type: 'channel_end', id });
		},
		abort() {
			send({ type: 'channel_reset', id, code: 'cancelled' });
			endSource(new Error('channel aborted'));
			teardown();
		},
	});

	return {
		channel: { source, sink },
		handleInbound(frame) {
			switch (frame.type) {
				case 'channel_data':
					if (!sourceEnded) controller?.enqueue(base64ToBytes(frame.bytes));
					return;
				case 'channel_end':
					endSource();
					return;
				case 'channel_reset':
					endSource(
						new Error(
							`channel reset: ${frame.code}${frame.reason ? ` (${frame.reason})` : ''}`,
						),
					);
					teardown();
					return;
			}
		},
	};
}
