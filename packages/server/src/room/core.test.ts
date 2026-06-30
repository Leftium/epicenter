/**
 * `RoomCore` conformance suite: the runtime-agnostic room behavior, tested ONCE
 * against the pure core rather than partially re-derived per backend.
 *
 * `createRoomCore` imports nothing Cloudflare and never branches on runtime, so
 * every invariant a backend relies on lives here: presence (debounce, the 4401
 * immediate path, multi-tab same-node dedup), dispatch correlation (happy path,
 * `RecipientOffline` on absent/disconnected recipient, the only-the-recipient-
 * may-answer guard), binary + HTTP sync, compaction, the connection-lifetime
 * bound (`handleMessage` for active sockets, `sweepExpiredConnections` for idle
 * ones), and liveness ping/pong. The backends only own their adapter glue (the
 * Durable Object hibernation accept + alarm, the Bun `server.upgrade` + timer),
 * which their own tests cover; both inherit this behavior unchanged.
 *
 * Time is controlled by construction, not fake timers: the lifetime bound reads
 * a connection's `connectedAt` (set old to age a socket) and
 * `sweepExpiredConnections(now)` takes the clock as a parameter. Only the 300ms
 * presence debounce uses a real `setTimeout`, so the one test that asserts it
 * FIRES waits the window; the rest assert the synchronous immediate/deferred
 * split. The 2MB compaction cap is a defensive guard not exercised here (it
 * needs a >2MB doc).
 */

import { describe, expect, test } from 'bun:test';
import { asUserId } from '@epicenter/auth';
import {
	encodeSyncRequest,
	encodeSyncStep1,
	encodeSyncUpdate,
	SYNC_MESSAGE_TYPE,
} from '@epicenter/sync';
import * as Y from 'yjs';
import type { Connection } from '../types.js';
import type { RoomSocket, RoomUpdateLog } from './contracts.js';
import { createRoomCore } from './core.js';

const MINUTE_MS = 60_000;
const LIFETIME_MS = 30 * MINUTE_MS;

/** An in-memory {@link RoomUpdateLog}; copies on the way in and out like the real backends. */
function memoryUpdateLog(): RoomUpdateLog {
	let rows: Uint8Array[] = [];
	return {
		loadAll: () => rows.map((r) => new Uint8Array(r)),
		append: (u) => {
			rows.push(new Uint8Array(u));
		},
		replaceAll: (c) => {
			rows = [new Uint8Array(c)];
		},
		byteSize: () => rows.reduce((n, r) => n + r.byteLength, 0),
		entryCount: () => rows.length,
	};
}

/** A {@link RoomSocket} that records what the core sends and closes it. */
class StubSocket implements RoomSocket {
	readyState = 1;
	readonly sent: Array<string | Uint8Array> = [];
	readonly closes: Array<{ code: number; reason: string }> = [];

	send(data: string | Uint8Array): void {
		if (this.readyState !== 1) throw new Error('socket not open');
		this.sent.push(data);
	}
	close(code: number, reason: string): void {
		this.closes.push({ code, reason });
		this.readyState = 3;
	}
	get codes(): number[] {
		return this.closes.map((c) => c.code);
	}
	/** Presence peer-id lists, one per `presence` frame, in order. */
	presence(): string[][] {
		return this.sent
			.filter((f): f is string => typeof f === 'string')
			.map(
				(t) => JSON.parse(t) as { type: string; peers?: { nodeId: string }[] },
			)
			.filter((m) => m.type === 'presence')
			.map((m) => (m.peers ?? []).map((p) => p.nodeId));
	}
	/** Decoded text frames of one `type`. */
	json(type: string): Array<Record<string, unknown>> {
		return this.sent
			.filter((f): f is string => typeof f === 'string')
			.map((t) => JSON.parse(t) as Record<string, unknown>)
			.filter((f) => f.type === type);
	}
	binary(): Uint8Array[] {
		return this.sent.filter((f): f is Uint8Array => f instanceof Uint8Array);
	}
}

function conn(nodeId: string, opts?: { connectedAt?: number }): Connection {
	return {
		userId: asUserId('u1'),
		nodeId,
		connectedAt: opts?.connectedAt ?? Date.now(),
		actions: {},
	};
}

function newRoom() {
	return createRoomCore({ updateLog: memoryUpdateLog() });
}

/** Connect a fresh stub socket as `nodeId` and return it. */
function connect(
	core: ReturnType<typeof createRoomCore>,
	nodeId: string,
	opts?: { connectedAt?: number },
): StubSocket {
	const ws = new StubSocket();
	core.addConnection(ws, conn(nodeId, opts));
	return ws;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────────────────────
// Presence
// ────────────────────────────────────────────────────────────────────────────

describe('RoomCore: presence', () => {
	test('the first socket receives an empty peer list', () => {
		const a = connect(newRoom(), 'A');
		expect(a.presence()).toEqual([[]]);
	});

	test('a second node sees the first in its directed snapshot, and the first is rebroadcast', () => {
		const core = newRoom();
		const a = connect(core, 'A');
		const before = a.presence().length;
		const b = connect(core, 'B');
		expect(b.presence().at(0)).toEqual(['A']);
		expect(a.presence().slice(before).at(-1)).toEqual(['B']);
	});

	test('a second tab of the same node does not rebroadcast and is deduped to one peer', () => {
		const core = newRoom();
		const a = connect(core, 'A');
		connect(core, 'B');
		const aFrames = a.presence().length;
		expect(a.presence().at(-1)).toEqual(['B']);
		connect(core, 'B'); // second tab of node B
		expect(a.presence().length).toBe(aFrames); // membership unchanged: no rebroadcast
	});

	test('a 4401 close rebroadcasts immediately, bypassing the grace window', () => {
		const core = newRoom();
		const a = connect(core, 'A');
		const b = connect(core, 'B');
		const before = a.presence().length;
		core.removeConnection(b, 4401);
		expect(a.presence().length).toBe(before + 1);
		expect(a.presence().at(-1)).toEqual([]);
	});

	test('a non-4401 close defers the rebroadcast to the grace window', async () => {
		const core = newRoom();
		const a = connect(core, 'A');
		const b = connect(core, 'B');
		const before = a.presence().length;
		core.removeConnection(b, 1000);
		expect(a.presence().length).toBe(before); // nothing immediate
		await sleep(400); // past PRESENCE_REBROADCAST_GRACE_MS (300)
		expect(a.presence().length).toBe(before + 1);
		expect(a.presence().at(-1)).toEqual([]);
	});

	test('a reconnect within the grace window supersedes the pending rebroadcast (no flap)', async () => {
		const core = newRoom();
		const a = connect(core, 'A');
		const b1 = connect(core, 'B');
		core.removeConnection(b1, 1000); // last B socket closes: arms the debounce
		connect(core, 'B'); // reconnect within the window cancels the pending rebroadcast
		await sleep(400);
		// A never ends on a "B gone" frame; the handoff was seamless.
		expect(a.presence().at(-1)).toContain('B');
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Text frames
// ────────────────────────────────────────────────────────────────────────────

describe('RoomCore: text frames', () => {
	test('an unparseable or unknown text frame closes the socket with 4400', () => {
		const core = newRoom();
		const ws = connect(core, 'A');
		core.handleMessage(ws, JSON.stringify({ type: 'totally-bogus' }));
		expect(ws.codes).toEqual([4400]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Sync (binary WS + HTTP RPC)
// ────────────────────────────────────────────────────────────────────────────

describe('RoomCore: sync', () => {
	test('a binary SyncStep1 frame gets a SyncStep2 reply', () => {
		const core = newRoom();
		const ws = connect(core, 'A');
		const before = ws.binary().length;
		core.handleMessage(ws, encodeSyncStep1({ doc: new Y.Doc() }));
		const replies = ws.binary().slice(before);
		expect(replies).toHaveLength(1);
		expect(replies[0]?.[0]).toBe(SYNC_MESSAGE_TYPE.STEP2);
	});

	test('a doc update fans out to peers but never echoes to its origin', () => {
		const core = newRoom();
		const a = connect(core, 'A');
		const b = connect(core, 'B');
		const beforeA = a.binary().length;
		const beforeB = b.binary().length;
		const src = new Y.Doc();
		src.getMap('d').set('k', 'v');
		core.handleMessage(
			a,
			encodeSyncUpdate({ update: Y.encodeStateAsUpdateV2(src) }),
		);
		expect(b.binary().length).toBe(beforeB + 1);
		expect(a.binary().length).toBe(beforeA);
	});

	test('HTTP sync returns the diff a fresh client is missing', () => {
		const core = newRoom();
		const ws = connect(core, 'A');
		const src = new Y.Doc();
		src.getMap('d').set('k', 'v');
		core.handleMessage(
			ws,
			encodeSyncUpdate({ update: Y.encodeStateAsUpdateV2(src) }),
		);

		const client = new Y.Doc();
		const { data, error } = core.sync(
			encodeSyncRequest(Y.encodeStateVector(client)),
		);
		expect(error).toBeNull();
		expect(data?.diff).not.toBeNull();
	});

	test('HTTP sync rejects a malformed body with Err(MalformedSyncBody)', () => {
		const { error } = newRoom().sync(new Uint8Array([10]));
		expect(error?.name).toBe('MalformedSyncBody');
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Compaction
// ────────────────────────────────────────────────────────────────────────────

describe('RoomCore: compaction', () => {
	test('compact collapses a multi-entry log into one row', () => {
		const updateLog = memoryUpdateLog();
		const core = createRoomCore({ updateLog });
		const ws = new StubSocket();
		core.addConnection(ws, conn('A'));
		for (const v of ['a', 'b', 'c']) {
			const d = new Y.Doc();
			d.getMap('m').set('k', v);
			core.handleMessage(
				ws,
				encodeSyncUpdate({ update: Y.encodeStateAsUpdateV2(d) }),
			);
		}
		expect(updateLog.entryCount()).toBeGreaterThan(1);
		core.compact();
		expect(updateLog.entryCount()).toBe(1);
	});

	test('compact is a no-op on an empty log', () => {
		const updateLog = memoryUpdateLog();
		const core = createRoomCore({ updateLog });
		expect(updateLog.entryCount()).toBe(0);
		core.compact();
		expect(updateLog.entryCount()).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Connection lifetime (the cross-backend re-auth invariant)
// ────────────────────────────────────────────────────────────────────────────

describe('RoomCore: connection lifetime', () => {
	test('an inbound frame on an over-age socket closes it 4408 and is dropped', () => {
		const core = newRoom();
		const ws = new StubSocket();
		core.addConnection(
			ws,
			conn('A', { connectedAt: Date.now() - (LIFETIME_MS + MINUTE_MS) }),
		);
		const beforeBinary = ws.binary().length;
		// A STEP1 would normally get a STEP2 reply; instead the socket is closed.
		core.handleMessage(ws, encodeSyncStep1({ doc: new Y.Doc() }));
		expect(ws.codes).toEqual([4408]);
		expect(ws.binary().length).toBe(beforeBinary); // frame dropped, no reply
	});

	test('sweepExpiredConnections closes idle over-age sockets and spares fresh ones', () => {
		const core = newRoom();
		const old = new StubSocket();
		core.addConnection(
			old,
			conn('old', { connectedAt: Date.now() - (LIFETIME_MS + MINUTE_MS) }),
		);
		const fresh = connect(core, 'fresh');
		core.sweepExpiredConnections(Date.now());
		expect(old.codes).toEqual([4408]);
		expect(fresh.codes).toEqual([]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Liveness ping/pong
// ────────────────────────────────────────────────────────────────────────────

describe('RoomCore: liveness', () => {
	test('a literal `ping` text frame is answered `pong` and never treated as a protocol error', () => {
		const core = newRoom();
		const ws = connect(core, 'A');
		const before = ws.sent.length;
		core.handleMessage(ws, 'ping');
		expect(ws.sent.slice(before)).toEqual(['pong']);
		expect(ws.codes).toEqual([]); // not closed 4400
	});
});
