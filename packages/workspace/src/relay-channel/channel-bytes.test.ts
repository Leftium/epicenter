/**
 * The bridge lifecycle, pinned against the leaks an adversarial review found: the
 * terminal reset must be deterministic (emitted on the writable's close, not
 * dependent on a reader cancel), an inbound reset must not echo, and malformed
 * base64 must be a controlled reset rather than a thrown crash through the frame
 * listener.
 */

import { describe, expect, test } from 'bun:test';
import { bytesToBase64, createChannelBridge } from './channel-bytes.js';
import type { ChannelFrame } from './protocol.js';

function makeBridge() {
	const sent: ChannelFrame[] = [];
	let teardowns = 0;
	const bridge = createChannelBridge({
		id: 'c1',
		send: (frame) => sent.push(frame),
		onTeardown: () => {
			teardowns += 1;
		},
	});
	return { bridge, sent, teardowns: () => teardowns };
}

const enc = (text: string) => new TextEncoder().encode(text);
const resets = (sent: ChannelFrame[]) =>
	sent.filter((frame) => frame.type === 'channel_reset');

describe('outbound', () => {
	test('a write becomes a channel_data frame with base64 bytes', async () => {
		const { bridge, sent } = makeBridge();
		await bridge.channel.sink.getWriter().write(enc('hi'));
		expect(sent).toEqual([
			{ type: 'channel_data', id: 'c1', bytes: bytesToBase64(enc('hi')) },
		]);
	});

	test('closing the writable emits exactly one channel_reset{closed} and tears down', async () => {
		const { bridge, sent, teardowns } = makeBridge();
		await bridge.channel.sink.getWriter().close();
		expect(sent).toEqual([{ type: 'channel_reset', id: 'c1', code: 'closed' }]);
		expect(teardowns()).toBe(1);
		// A later reader cancel must not emit a second reset (shared close guard).
		await bridge.channel.source.getReader().cancel();
		expect(resets(sent).length).toBe(1);
	});

	test('aborting the writable resets with cancelled', async () => {
		const { bridge, sent } = makeBridge();
		await bridge.channel.sink.getWriter().abort();
		expect(resets(sent)).toEqual([
			{ type: 'channel_reset', id: 'c1', code: 'cancelled' },
		]);
	});
});

describe('inbound', () => {
	test('channel_data is readable from the source', async () => {
		const { bridge } = makeBridge();
		const reader = bridge.channel.source.getReader();
		bridge.handleInbound({ type: 'channel_data', id: 'c1', bytes: bytesToBase64(enc('yo')) });
		const { value } = await reader.read();
		expect(value && new TextDecoder().decode(value)).toBe('yo');
	});

	test('an inbound reset{closed} ends the source cleanly, echoes no reset, and tears down', async () => {
		const { bridge, sent, teardowns } = makeBridge();
		const reader = bridge.channel.source.getReader();
		bridge.handleInbound({ type: 'channel_reset', id: 'c1', code: 'closed' });
		const { done } = await reader.read();
		expect(done).toBe(true);
		expect(sent).toEqual([]); // peer reset is not echoed back
		expect(teardowns()).toBe(1);
	});

	test('an inbound reset with an error code rejects an in-flight read', async () => {
		const { bridge } = makeBridge();
		const reader = bridge.channel.source.getReader();
		let rejected = false;
		const read = reader.read().catch(() => {
			rejected = true;
		});
		bridge.handleInbound({ type: 'channel_reset', id: 'c1', code: 'offline' });
		await read;
		expect(rejected).toBe(true);
	});

	test('malformed base64 is a controlled protocol_error reset, never a throw', () => {
		const { bridge, sent, teardowns } = makeBridge();
		expect(() =>
			bridge.handleInbound({ type: 'channel_data', id: 'c1', bytes: '@@@@@' }),
		).not.toThrow();
		expect(sent).toEqual([
			{ type: 'channel_reset', id: 'c1', code: 'protocol_error' },
		]);
		expect(teardowns()).toBe(1);
	});

	test('an oversized inbound channel_data is reset too_large, never decoded or buffered', () => {
		const { bridge, sent, teardowns } = makeBridge();
		// 3 MiB of base64 chars is well past the ~1 MiB raw receive ceiling, so the
		// frame is refused on its length before `atob` ever allocates its bytes.
		const oversized = 'A'.repeat(3 * 1024 * 1024);
		expect(() =>
			bridge.handleInbound({ type: 'channel_data', id: 'c1', bytes: oversized }),
		).not.toThrow();
		expect(resets(sent)).toEqual([
			{ type: 'channel_reset', id: 'c1', code: 'too_large' },
		]);
		expect(teardowns()).toBe(1);
	});
});

/** Concatenate byte parts in order into one buffer. */
function concatBytes(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

describe('streaming hardening', () => {
	test('a payload larger than the wire ceiling round-trips across many frames, no frame trips the 1009 kill', async () => {
		// Mirror `packages/server`'s `MAX_PAYLOAD_BYTES` (the constant `RoomCore`
		// enforces). The server compares `message.length` for a text frame, so the
		// faithful check here is `JSON.stringify(frame).length`, not byteLength.
		const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

		// The receiver: reassembles the inbound `channel_data` frames into one stream.
		const recv = createChannelBridge({
			id: 'c1',
			send: () => {},
			onTeardown: () => {},
		});

		// The sender's `send` stands in for the relay socket: it enforces the wire
		// ceiling (a frame over it would close the shared socket with 1009 and kill
		// Yjs sync as collateral) and forwards the channel's frames to the receiver.
		let socketKilled = false;
		let maxFrameLength = 0;
		const dataFrames: ChannelFrame[] = [];
		const sender = createChannelBridge({
			id: 'c1',
			send: (frame) => {
				const length = JSON.stringify(frame).length;
				maxFrameLength = Math.max(maxFrameLength, length);
				if (length > MAX_PAYLOAD_BYTES) {
					socketKilled = true;
					return;
				}
				if (frame.type === 'channel_data') dataFrames.push(frame);
				if (frame.type === 'channel_data' || frame.type === 'channel_reset') {
					recv.handleInbound(frame);
				}
			},
			onTeardown: () => {},
		});

		// A 6 MiB payload: larger than the 5 MiB wire ceiling, so it MUST split
		// across frames or it would never reach the peer. Deterministic byte pattern
		// so the round-trip check catches any corruption or reordering.
		const size = 6 * 1024 * 1024;
		const payload = new Uint8Array(size);
		for (let i = 0; i < size; i += 1) payload[i] = i & 0xff;

		// Drain the receiver concurrently with the write so its queue does not grow
		// unread; reassemble what arrived.
		const readAll = (async () => {
			const reader = recv.channel.source.getReader();
			const parts: Uint8Array[] = [];
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value) parts.push(value);
			}
			return concatBytes(parts);
		})();

		const writer = sender.channel.sink.getWriter();
		await writer.write(payload);
		await writer.close();

		const received = await readAll;

		expect(socketKilled).toBe(false);
		expect(maxFrameLength).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
		expect(dataFrames.length).toBeGreaterThan(1);
		expect(received.byteLength).toBe(size);
		let intact = true;
		for (let i = 0; i < size; i += 1) {
			if (received[i] !== (i & 0xff)) {
				intact = false;
				break;
			}
		}
		expect(intact).toBe(true);
	});

	test('a flooding writer is throttled: write() pends past the high-water mark instead of resolving synchronously', async () => {
		const sender = createChannelBridge({
			id: 'c1',
			send: () => {},
			onTeardown: () => {},
		});
		const writer = sender.channel.sink.getWriter();

		// 2 MiB is well past the outbound high-water mark, so `write` must pend on a
		// macrotask (real backpressure) rather than resolve within microtasks the way
		// the old fire-and-forget sink did.
		const big = new Uint8Array(2 * 1024 * 1024);
		let resolved = false;
		const write = writer.write(big).then(() => {
			resolved = true;
		});

		// Flush the microtask queue. A fire-and-forget write would already be settled;
		// a macrotask-throttled one is still pending because no macrotask has run.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(resolved).toBe(false);

		// Let macrotasks run; the throttle releases and the write settles.
		await write;
		expect(resolved).toBe(true);
	});
});
