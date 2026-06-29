/**
 * The selecting transport is the one seam over iroh and the relay floor, so the
 * test pins the selection rule: auto prefers iroh and falls back to the floor on
 * an iroh dial failure or its absence; prefer forces one; and a missing forced
 * transport is an error, not a silent wrong choice.
 */

import { describe, expect, test } from 'bun:test';
import type {
	ByteChannel,
	OpenChannelOptions,
	PeerTransport,
} from './peer-transport.js';
import { asPeerId, asRouteName } from './peer-transport.js';
import { createSelectingTransport } from './select-transport.js';

/** A fake transport that records its opens and resolves (or rejects) a sentinel channel. */
function fakeTransport(behavior: 'ok' | 'fail') {
	const opens: OpenChannelOptions[] = [];
	const channel = {} as ByteChannel; // identity sentinel; never read
	const transport: PeerTransport = {
		openChannel: async (opts) => {
			opens.push(opts);
			if (behavior === 'fail') throw new Error('dial failed');
			return channel;
		},
	};
	return { transport, opens, channel };
}

const opts: OpenChannelOptions = {
	target: asPeerId('laptop'),
	route: asRouteName('books'),
};

describe('auto', () => {
	test('uses iroh when both are present and iroh succeeds', async () => {
		const iroh = fakeTransport('ok');
		const relay = fakeTransport('ok');
		const t = createSelectingTransport({
			iroh: iroh.transport,
			relay: relay.transport,
		});
		expect(await t.openChannel(opts)).toBe(iroh.channel);
		expect(iroh.opens).toHaveLength(1);
		expect(relay.opens).toHaveLength(0);
	});

	test('falls back to the floor when the iroh dial fails', async () => {
		const iroh = fakeTransport('fail');
		const relay = fakeTransport('ok');
		const t = createSelectingTransport({
			iroh: iroh.transport,
			relay: relay.transport,
		});
		expect(await t.openChannel(opts)).toBe(relay.channel);
		expect(iroh.opens).toHaveLength(1);
		expect(relay.opens).toHaveLength(1);
	});

	test('uses the floor when there is no iroh (a browser)', async () => {
		const relay = fakeTransport('ok');
		const t = createSelectingTransport({ relay: relay.transport });
		expect(await t.openChannel(opts)).toBe(relay.channel);
		expect(relay.opens).toHaveLength(1);
	});
});

describe('prefer', () => {
	test("prefer 'relay' forces the floor even when iroh is present", async () => {
		const iroh = fakeTransport('ok');
		const relay = fakeTransport('ok');
		const t = createSelectingTransport({
			iroh: iroh.transport,
			relay: relay.transport,
			prefer: 'relay',
		});
		expect(await t.openChannel(opts)).toBe(relay.channel);
		expect(iroh.opens).toHaveLength(0);
	});

	test("prefer 'iroh' forces iroh and does NOT fall back", async () => {
		const iroh = fakeTransport('fail');
		const relay = fakeTransport('ok');
		const t = createSelectingTransport({
			iroh: iroh.transport,
			relay: relay.transport,
			prefer: 'iroh',
		});
		let failed = false;
		try {
			await t.openChannel(opts);
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
		expect(relay.opens).toHaveLength(0);
	});

	test("prefer 'relay' with no relay is an error", async () => {
		const iroh = fakeTransport('ok');
		const t = createSelectingTransport({ iroh: iroh.transport, prefer: 'relay' });
		let failed = false;
		try {
			await t.openChannel(opts);
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
	});
});

test('constructing with no transport throws', () => {
	expect(() => createSelectingTransport({})).toThrow();
});
