/**
 * The relay floor through the REAL room: channel frames driven into
 * `createRoomCore.handleMessage` between two connections, proving the core
 * delegates `channel_*` frames to the channel router and the router forwards
 * them blind between a caller and a same-owner target. The transport, acceptor,
 * and MCP framing on top are proven in `packages/workspace`
 * `relay-channel/transport.test.ts`; the two halves meet at this wire protocol.
 *
 * The relay is payload-blind, so the test forwards arbitrary base64 bytes: that
 * is exactly what it does for real MCP bytes.
 */

import { describe, expect, test } from 'bun:test';
import {
	type ChannelFrame,
	checkChannelFrame,
} from '@epicenter/workspace/relay-channel';
import type { Connection } from '../types.js';
import type { RoomSocket, RoomUpdateLog } from './contracts.js';
import { createRoomCore } from './core.js';

/** An in-memory update log; this test never exercises sync, only channel frames. */
function memLog(): RoomUpdateLog {
	const entries: Uint8Array[] = [];
	return {
		loadAll: () => [...entries],
		append: (update) => void entries.push(update),
		replaceAll: (compacted) => {
			entries.length = 0;
			entries.push(compacted);
		},
		byteSize: () => entries.reduce((sum, entry) => sum + entry.byteLength, 0),
		entryCount: () => entries.length,
	};
}

/** A room socket that records only the channel frames the core sends to it. */
function fakeSocket() {
	const frames: ChannelFrame[] = [];
	const socket: RoomSocket = {
		readyState: 1,
		close: () => {},
		send: (data) => {
			// The core also sends binary sync frames and JSON presence; keep only the
			// channel frames this test asserts on.
			if (typeof data !== 'string') return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(data);
			} catch {
				return;
			}
			if (checkChannelFrame.Check(parsed)) frames.push(parsed);
		},
	};
	return { socket, frames };
}

function conn(nodeId: string, userId = 'u1'): Connection {
	return {
		userId: userId as Connection['userId'],
		nodeId,
		connectedAt: Date.now(),
		actions: {},
	};
}

/** Drive one channel frame into the core as that socket's inbound message. */
function send(
	core: ReturnType<typeof createRoomCore>,
	socket: RoomSocket,
	frame: ChannelFrame,
): void {
	core.handleMessage(socket, JSON.stringify(frame));
}

/** A room with a caller (`phone`) and a same-owner target (`laptop`) connected. */
function setup() {
	const core = createRoomCore({ updateLog: memLog() });
	const caller = fakeSocket();
	const target = fakeSocket();
	core.addConnection(caller.socket, conn('phone'));
	core.addConnection(target.socket, conn('laptop'));
	return { core, caller, target };
}

describe('relay channels through createRoomCore', () => {
	test('open is delivered to the target, then accept and data are forwarded both ways', () => {
		const { core, caller, target } = setup();
		const open: ChannelFrame = {
			type: 'channel_open',
			id: 'c1',
			target: 'laptop',
			route: 'books',
		};
		send(core, caller.socket, open);
		// The relay stamps the server-authored source onto the forwarded open.
		expect(target.frames).toEqual([
			{ ...open, source: { kind: 'user', userId: 'u1' } },
		]);
		expect(caller.frames).toEqual([]);

		const accept: ChannelFrame = { type: 'channel_accept', id: 'c1' };
		send(core, target.socket, accept);
		expect(caller.frames).toEqual([accept]);

		const req: ChannelFrame = { type: 'channel_data', id: 'c1', bytes: 'cmVx' };
		send(core, caller.socket, req);
		expect(target.frames.at(-1)).toEqual(req);

		const res: ChannelFrame = { type: 'channel_data', id: 'c1', bytes: 'cmVz' };
		send(core, target.socket, res);
		expect(caller.frames.at(-1)).toEqual(res);
	});

	test('overwrites a caller-forged source with the authenticated owner', () => {
		const { core, caller, target } = setup();
		send(core, caller.socket, {
			type: 'channel_open',
			id: 'c1',
			target: 'laptop',
			route: 'books',
			// A caller tries to forge a different identity.
			source: { kind: 'user', userId: 'attacker' },
		});
		expect(target.frames.at(-1)).toMatchObject({
			source: { kind: 'user', userId: 'u1' }, // the relay's, not the forged one
		});
	});

	test('refuses an open to a different owner', () => {
		const { core, caller } = setup();
		const intruder = fakeSocket();
		core.addConnection(intruder.socket, conn('intruder', 'u2'));
		send(core, caller.socket, {
			type: 'channel_open',
			id: 'c2',
			target: 'intruder',
			route: 'books',
		});
		expect(caller.frames.at(-1)).toMatchObject({
			type: 'channel_reset',
			id: 'c2',
			code: 'refused',
		});
		expect(intruder.frames).toEqual([]);
	});

	test('rejects an open to an offline device with offline', () => {
		const { core, caller } = setup();
		send(core, caller.socket, {
			type: 'channel_open',
			id: 'c3',
			target: 'ghost',
			route: 'books',
		});
		expect(caller.frames.at(-1)).toEqual({
			type: 'channel_reset',
			id: 'c3',
			code: 'offline',
		});
	});

	test('resets the caller when the target connection drops', () => {
		const { core, caller, target } = setup();
		send(core, caller.socket, {
			type: 'channel_open',
			id: 'c4',
			target: 'laptop',
			route: 'books',
		});
		core.removeConnection(target.socket, 1006);
		expect(caller.frames.at(-1)).toMatchObject({
			type: 'channel_reset',
			id: 'c4',
			code: 'offline',
		});
	});

	test('a non-party cannot drive a channel it does not own', () => {
		const { core, caller, target } = setup();
		send(core, caller.socket, {
			type: 'channel_open',
			id: 'c5',
			target: 'laptop',
			route: 'books',
		});
		const stranger = fakeSocket();
		core.addConnection(stranger.socket, conn('stranger'));
		const before = target.frames.length;
		send(core, stranger.socket, {
			type: 'channel_data',
			id: 'c5',
			bytes: 'eA==',
		});
		expect(target.frames.length).toBe(before); // dropped: not a party
	});
});
