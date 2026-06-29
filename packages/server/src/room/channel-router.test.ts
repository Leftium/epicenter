/**
 * The channel router is the relay's blind forwarder, so the test pins exactly
 * what it forwards and what it refuses: an open reaches a same-owner online
 * device, an offline or cross-owner target is rejected to the caller, bytes flow
 * both ways, a reset tears the channel down, a non-party cannot inject, and a
 * dropped socket resets its peer.
 */

import { describe, expect, test } from 'bun:test';
import type { ChannelFrame } from '@epicenter/workspace/relay-channel';
import { createChannelRouter } from './channel-router.js';
import type { RoomSocket } from './contracts.js';

/** A fake room socket that records the channel frames sent to it. */
function fakeSocket(readyState = 1) {
	const sent: ChannelFrame[] = [];
	const socket: RoomSocket = {
		send: (data) => sent.push(JSON.parse(String(data)) as ChannelFrame),
		close: () => {},
		readyState,
	};
	return { socket, sent };
}

/** A caller and a same-owner online target wired into a fresh router. */
function setup() {
	const caller = fakeSocket();
	const target = fakeSocket();
	const devices = new Map<string, RoomSocket>([
		['phone', caller.socket],
		['laptop', target.socket],
	]);
	const owners = new Map<RoomSocket, string>([
		[caller.socket, 'u1'],
		[target.socket, 'u1'],
	]);
	const router = createChannelRouter({
		findDevice: (nodeId) => devices.get(nodeId) ?? null,
		ownerOf: (socket) => owners.get(socket),
	});
	return { caller, target, devices, owners, router };
}

const open: ChannelFrame = {
	type: 'channel_open',
	id: 'c1',
	target: 'laptop',
	route: 'books',
};

describe('channel open', () => {
	test('forwards an open to a same-owner online target, no reset to caller', () => {
		const { caller, target, router } = setup();
		router.handleFrame(caller.socket, open);
		// The relay stamps the server-authored source onto the forwarded open.
		expect(target.sent).toEqual([
			{ ...open, source: { kind: 'user', userId: 'u1' } },
		]);
		expect(caller.sent).toEqual([]);
	});

	test('rejects an open to an offline device with offline', () => {
		const { caller, router } = setup();
		router.handleFrame(caller.socket, {
			type: 'channel_open',
			id: 'c1',
			target: 'tablet', // not in the device map
			route: 'books',
		});
		expect(caller.sent).toEqual([
			{ type: 'channel_reset', id: 'c1', code: 'offline' },
		]);
	});

	test('refuses an open to a different owner', () => {
		const { caller, target, owners, router } = setup();
		owners.set(target.socket, 'u2'); // target now a different user
		router.handleFrame(caller.socket, open);
		expect(target.sent).toEqual([]);
		expect(caller.sent[0]).toMatchObject({
			type: 'channel_reset',
			id: 'c1',
			code: 'refused',
		});
	});

	test('rejects a duplicate channel id with protocol_error', () => {
		const { caller, router } = setup();
		router.handleFrame(caller.socket, open);
		router.handleFrame(caller.socket, open);
		expect(caller.sent[0]).toMatchObject({
			type: 'channel_reset',
			code: 'protocol_error',
		});
	});
});

describe('established channel', () => {
	test('forwards data both directions and accept back to the caller', () => {
		const { caller, target, router } = setup();
		router.handleFrame(caller.socket, open);

		const accept: ChannelFrame = { type: 'channel_accept', id: 'c1' };
		router.handleFrame(target.socket, accept);
		expect(caller.sent).toEqual([accept]);

		const req: ChannelFrame = { type: 'channel_data', id: 'c1', bytes: 'cmVx' };
		router.handleFrame(caller.socket, req);
		expect(target.sent.at(-1)).toEqual(req);

		const res: ChannelFrame = { type: 'channel_data', id: 'c1', bytes: 'cmVz' };
		router.handleFrame(target.socket, res);
		expect(caller.sent.at(-1)).toEqual(res);
	});

	test('a reset forwards then deletes the channel, dropping later frames', () => {
		const { caller, target, router } = setup();
		router.handleFrame(caller.socket, open);

		const reset: ChannelFrame = { type: 'channel_reset', id: 'c1', code: 'cancelled' };
		router.handleFrame(caller.socket, reset);
		expect(target.sent.at(-1)).toEqual(reset);

		const sentBefore = target.sent.length;
		router.handleFrame(caller.socket, { type: 'channel_data', id: 'c1', bytes: 'eA==' });
		expect(target.sent.length).toBe(sentBefore); // dropped: channel gone
	});

	test('a non-party socket cannot inject into a channel', () => {
		const { caller, target, router } = setup();
		router.handleFrame(caller.socket, open);
		const stranger = fakeSocket();
		const before = target.sent.length;
		router.handleFrame(stranger.socket, { type: 'channel_data', id: 'c1', bytes: 'eA==' });
		expect(target.sent.length).toBe(before); // dropped: not a party
	});
});

describe('onClose', () => {
	test('resets the caller when the target drops', () => {
		const { caller, target, router } = setup();
		router.handleFrame(caller.socket, open);
		router.onClose(target.socket);
		expect(caller.sent.at(-1)).toMatchObject({
			type: 'channel_reset',
			id: 'c1',
			code: 'offline',
		});
	});

	test('resets the target when the caller drops', () => {
		const { caller, target, router } = setup();
		router.handleFrame(caller.socket, open);
		router.onClose(caller.socket);
		expect(target.sent.at(-1)).toMatchObject({
			type: 'channel_reset',
			id: 'c1',
			code: 'closed',
		});
	});
});
