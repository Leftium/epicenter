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
});
