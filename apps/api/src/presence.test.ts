/**
 * Server-owned presence tests.
 *
 * Exercises the `Room` DO's presence emission path: snapshot-on-upgrade,
 * `presence_added` on first socket, `presence_removed` on last socket
 * (after grace), multi-tab dedup, graceful handoff cancellation, 4401
 * grace bypass, and broadcast resilience against wedged sockets.
 *
 * Bun's test runtime does not provide Cloudflare Workers globals, so we
 * mock `cloudflare:workers` (DurableObject base class), shim
 * `WebSocketPair` / `WebSocket`, and drive the Room via its public
 * `fetch()` and `webSocketClose()` overrides directly.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// ────────────────────────────────────────────────────────────────────────────
// CLOUDFLARE WORKERS SHIMS
// ────────────────────────────────────────────────────────────────────────────

// `WebSocket` is a host global in real Workers but Bun ships its own
// WebSocket class without a `WebSocketPair`. Provide a minimal stub good
// enough for the Room's send/close/readyState surface.
class StubWebSocket {
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState: number = StubWebSocket.OPEN;
	sent: Array<Uint8Array | string> = [];
	closeCalls: Array<{ code: number; reason: string }> = [];
	private attachment: unknown = null;
	private failOnSend = false;

	send(data: Uint8Array | string): void {
		if (this.failOnSend) throw new Error('wedged');
		if (this.readyState !== StubWebSocket.OPEN) {
			throw new Error('socket not open');
		}
		this.sent.push(data);
	}

	close(code: number, reason: string): void {
		this.closeCalls.push({ code, reason });
		this.readyState = StubWebSocket.CLOSED;
	}

	serializeAttachment(value: unknown): void {
		this.attachment = value;
	}

	deserializeAttachment(): unknown {
		return this.attachment;
	}

	// Test-only: simulate a wedged peer whose `send` always throws.
	__wedge(): void {
		this.failOnSend = true;
	}

	// Test-only: pull text frames out of `sent`.
	textFrames(): string[] {
		return this.sent.filter((f): f is string => typeof f === 'string');
	}
}

class StubWebSocketPair {
	0: StubWebSocket;
	1: StubWebSocket;
	constructor() {
		this[0] = new StubWebSocket();
		this[1] = new StubWebSocket();
	}
}

// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
(globalThis as any).WebSocket ??= StubWebSocket;
// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
(globalThis as any).WebSocketPair ??= StubWebSocketPair;

// `cloudflare:workers` is not resolvable in Bun. Mock it with a barebones
// DurableObject base class that records `ctx` and `env` so Room's
// constructor can run.
mock.module('cloudflare:workers', () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

// ────────────────────────────────────────────────────────────────────────────
// DURABLE OBJECT CTX STUB
// ────────────────────────────────────────────────────────────────────────────

type SqlRow = { id: number; data: ArrayBuffer };

/**
 * In-memory SQL surface that satisfies the subset of `ctx.storage.sql`
 * the Room touches: schema DDL, SELECT all updates, INSERT, DELETE,
 * COUNT, and `databaseSize`.
 */
function makeSqlStorage() {
	const updates: SqlRow[] = [];
	let nextId = 1;

	function exec(query: string, ...params: unknown[]): { toArray(): SqlRow[]; one(): { count: number } } {
		const q = query.trim().toUpperCase();
		if (q.startsWith('CREATE TABLE')) {
			return { toArray: () => [], one: () => ({ count: 0 }) };
		}
		if (q.startsWith('SELECT DATA FROM UPDATES')) {
			return { toArray: () => [...updates], one: () => ({ count: updates.length }) };
		}
		if (q.startsWith('SELECT COUNT(*)')) {
			return {
				toArray: () => [],
				one: () => ({ count: updates.length }),
			};
		}
		if (q.startsWith('INSERT INTO UPDATES')) {
			const blob = params[0] as Uint8Array;
			const copy = new ArrayBuffer(blob.byteLength);
			new Uint8Array(copy).set(blob);
			updates.push({ id: nextId++, data: copy });
			return { toArray: () => [], one: () => ({ count: 0 }) };
		}
		if (q.startsWith('DELETE FROM UPDATES')) {
			updates.length = 0;
			return { toArray: () => [], one: () => ({ count: 0 }) };
		}
		throw new Error(`Unsupported SQL: ${query}`);
	}

	return {
		exec,
		get databaseSize() {
			return updates.reduce((acc, r) => acc + r.data.byteLength, 0);
		},
		transactionSync(fn: () => void) {
			fn();
		},
	};
}

function makeStorage() {
	return {
		sql: makeSqlStorage(),
		async setAlarm(_when: number) {},
		async deleteAlarm() {},
		async deleteAll() {},
	};
}

type StubCtx = {
	storage: ReturnType<typeof makeStorage>;
	acceptedSockets: StubWebSocket[];
	acceptWebSocket(ws: StubWebSocket): void;
	getWebSockets(): StubWebSocket[];
	blockConcurrencyWhile(fn: () => Promise<unknown>): Promise<void>;
	setWebSocketAutoResponse(_pair: unknown): void;
};

function makeCtx(): StubCtx {
	const acceptedSockets: StubWebSocket[] = [];
	return {
		storage: makeStorage(),
		acceptedSockets,
		acceptWebSocket(ws: StubWebSocket) {
			acceptedSockets.push(ws);
		},
		getWebSockets() {
			return acceptedSockets.slice();
		},
		async blockConcurrencyWhile(fn: () => Promise<unknown>) {
			await fn();
		},
		setWebSocketAutoResponse(_pair: unknown) {},
	};
}

// `WebSocketRequestResponsePair` is a global constructor in real Workers.
// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
(globalThis as any).WebSocketRequestResponsePair ??= class {
	constructor(_a: string, _b: string) {}
};

// ────────────────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: Room exposes typed CF surfaces
// (DurableObject, WebSocket) we are stubbing; cast to keep tests pragmatic.
type RoomLike = any;

async function makeRoom(): Promise<{ room: RoomLike; ctx: StubCtx }> {
	// Dynamic import so the cloudflare:workers mock is in place.
	const { Room } = await import('./room.js');
	const ctx = makeCtx();
	// biome-ignore lint/suspicious/noExplicitAny: env unused in our scenarios
	const room = new Room(ctx as any, {} as any) as RoomLike;
	// blockConcurrencyWhile is fire-and-forget in real CF; await readiness here.
	await Promise.resolve();
	return { room, ctx };
}

function upgradeRequest(installationId: string): Request {
	return new Request(
		`https://relay.test/?installationId=${installationId}`,
		{
			method: 'GET',
			headers: {
				Upgrade: 'websocket',
				'sec-websocket-protocol': 'epicenter',
			},
		},
	);
}

/** Drive an upgrade end-to-end and return the server-side socket. */
async function upgrade(
	room: RoomLike,
	installationId: string,
): Promise<StubWebSocket> {
	const response = await room.fetch(upgradeRequest(installationId));
	expect(response.status).toBe(101);
	// In real CF the response carries the CLIENT socket on `response.webSocket`;
	// Bun's `Response` ignores the field but the server socket is the
	// most-recently `acceptWebSocket`'d one.
	const ctx = room.ctx as StubCtx;
	const serverSocket = ctx.acceptedSockets[ctx.acceptedSockets.length - 1]!;
	return serverSocket;
}

/** Parse all `presence_*` text frames out of the wire. */
function presenceFrames(ws: StubWebSocket): Array<{ type: string; install?: string; installs?: string[] }> {
	return ws
		.textFrames()
		.map((t) => {
			try {
				return JSON.parse(t);
			} catch {
				return null;
			}
		})
		.filter(
			(p): p is { type: string; install?: string; installs?: string[] } =>
				p !== null && typeof p === 'object' && typeof p.type === 'string' && p.type.startsWith('presence_'),
		);
}

// ────────────────────────────────────────────────────────────────────────────
// TESTS
// ────────────────────────────────────────────────────────────────────────────

describe('Room presence: snapshot on upgrade', () => {
	test('first socket receives an empty snapshot', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		const frames = presenceFrames(ws);
		expect(frames).toEqual([{ type: 'presence_snapshot', installs: [] }]);
	});

	test('second install upgrade sees the first install in its snapshot', async () => {
		const { room } = await makeRoom();
		await upgrade(room, 'A');
		const ws = await upgrade(room, 'B');
		const frames = presenceFrames(ws);
		expect(frames).toEqual([{ type: 'presence_snapshot', installs: ['A'] }]);
	});
});

describe('Room presence: added broadcast', () => {
	test('first socket for an install broadcasts presence_added to existing peers', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const before = presenceFrames(wsA).length;
		await upgrade(room, 'B');
		const after = presenceFrames(wsA).slice(before);
		expect(after).toEqual([{ type: 'presence_added', install: 'B' }]);
	});

	test('subsequent socket for the SAME install does NOT broadcast presence_added', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		await upgrade(room, 'B'); // first B socket: presence_added broadcast
		const beforeSecondTab = presenceFrames(wsA).length;
		await upgrade(room, 'B'); // second B tab: no broadcast
		const after = presenceFrames(wsA).slice(beforeSecondTab);
		expect(after).toEqual([]);
	});

	test('snapshot to the newly-added install excludes self', async () => {
		const { room } = await makeRoom();
		await upgrade(room, 'A');
		await upgrade(room, 'B');
		const ws = await upgrade(room, 'A'); // second A tab
		const frames = presenceFrames(ws);
		// The first frame to the new tab is the snapshot. It contains only B.
		expect(frames[0]).toEqual({ type: 'presence_snapshot', installs: ['B'] });
	});
});

describe('Room presence: removed broadcast', () => {
	test('last socket close schedules presence_removed and fires after grace', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		// Close B.
		const beforeClose = presenceFrames(wsA).length;
		await room.webSocketClose(wsB, 1000, 'bye', true);
		// Immediately after close: nothing yet (grace window armed).
		const justAfter = presenceFrames(wsA).slice(beforeClose);
		expect(justAfter).toEqual([]);

		await new Promise((r) => setTimeout(r, 350));
		const afterGrace = presenceFrames(wsA).slice(beforeClose);
		expect(afterGrace).toEqual([{ type: 'presence_removed', install: 'B' }]);
	});

	test('intermediate socket close (multi-tab) emits NO presence_removed', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB1 = await upgrade(room, 'B');
		await upgrade(room, 'B'); // second B tab keeps the install alive
		const before = presenceFrames(wsA).length;
		await room.webSocketClose(wsB1, 1000, 'bye', true);
		await new Promise((r) => setTimeout(r, 350));
		const after = presenceFrames(wsA).slice(before);
		expect(after).toEqual([]);
	});

	test('real disconnect (no replacement) fires presence_removed exactly once', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		await room.webSocketClose(wsB, 1000, 'bye', true);
		await new Promise((r) => setTimeout(r, 350));
		const removed = presenceFrames(wsA).filter((f) => f.type === 'presence_removed');
		expect(removed).toEqual([{ type: 'presence_removed', install: 'B' }]);
	});
});

describe('Room presence: graceful handoff', () => {
	test('close + reconnect within grace cancels removed; no added emitted', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB1 = await upgrade(room, 'B');
		const baseline = presenceFrames(wsA).length;

		await room.webSocketClose(wsB1, 1000, 'tab handoff', true);

		// Reconnect well inside the 300 ms grace.
		await new Promise((r) => setTimeout(r, 50));
		await upgrade(room, 'B');

		// Let the grace timer fire to prove it was cancelled.
		await new Promise((r) => setTimeout(r, 350));

		const frames = presenceFrames(wsA).slice(baseline);
		// Peer A sees nothing: no added, no removed.
		expect(frames).toEqual([]);
	});

	test('cancel-then-replace: T1 closes, T2 connects inside grace, T2 closes outside grace -> one removed', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB1 = await upgrade(room, 'B');
		const baseline = presenceFrames(wsA).length;

		await room.webSocketClose(wsB1, 1000, 'tab handoff', true);
		await new Promise((r) => setTimeout(r, 100));
		const wsB2 = await upgrade(room, 'B');
		// Past the original grace window from B1's close:
		await new Promise((r) => setTimeout(r, 350));

		// No removed yet (replacement cancelled it; B2 keeps the install alive).
		const midFrames = presenceFrames(wsA).slice(baseline);
		expect(midFrames.filter((f) => f.type === 'presence_removed')).toEqual([]);

		// Now close B2 with no replacement.
		const afterMid = presenceFrames(wsA).length;
		await room.webSocketClose(wsB2, 1000, 'gone', true);
		await new Promise((r) => setTimeout(r, 350));
		const tailFrames = presenceFrames(wsA).slice(afterMid);
		expect(tailFrames.filter((f) => f.type === 'presence_removed')).toEqual([
			{ type: 'presence_removed', install: 'B' },
		]);
	});
});

describe('Room presence: hibernation/wake', () => {
	test('connections survive a fresh DO construction with the same ctx', async () => {
		// Simulate hibernation by constructing a second `Room` that shares
		// `ctx.getWebSockets()`. The new Room must rebuild `connections`
		// from the surviving sockets without emitting spurious presence
		// transitions to them.
		const { Room } = await import('./room.js');
		const ctx = makeCtx();
		// biome-ignore lint/suspicious/noExplicitAny: env unused
		const r1 = new Room(ctx as any, {} as any);
		await Promise.resolve();

		await upgrade(r1, 'A');
		await upgrade(r1, 'B');

		// Build a "woken" Room reusing the same accepted sockets.
		// biome-ignore lint/suspicious/noExplicitAny: env unused
		const r2 = new Room(ctx as any, {} as any);
		await Promise.resolve();

		// A new upgrade post-wake should see both A and B in its snapshot.
		const wsC = await upgrade(r2, 'C');
		const frames = presenceFrames(wsC);
		expect(frames[0]).toEqual({
			type: 'presence_snapshot',
			installs: ['A', 'B'],
		});
	});
});

describe('Room presence: 4401 bypasses grace', () => {
	test('close code 4401 emits presence_removed immediately', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		const before = presenceFrames(wsA).length;

		await room.webSocketClose(wsB, 4401, 'auth expired', false);
		// No grace wait.
		const after = presenceFrames(wsA).slice(before);
		expect(after).toEqual([{ type: 'presence_removed', install: 'B' }]);
	});

	test('close code 4401 clears any pending grace timer for the same install', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB1 = await upgrade(room, 'B');
		const wsB2 = await upgrade(room, 'B');

		// Non-auth close arms the grace timer (but B2 still alive so it's a no-op anyway).
		await room.webSocketClose(wsB1, 1000, 'tab handoff', true);
		// 4401 close on the last surviving socket: immediate removed, no later double-fire.
		const before = presenceFrames(wsA).length;
		await room.webSocketClose(wsB2, 4401, 'auth expired', false);
		await new Promise((r) => setTimeout(r, 350));
		const removed = presenceFrames(wsA)
			.slice(before)
			.filter((f) => f.type === 'presence_removed');
		expect(removed).toEqual([{ type: 'presence_removed', install: 'B' }]);
	});
});

describe('Room presence: broadcast resilience', () => {
	test('a wedged socket does not abort the broadcast loop', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		// Wedge A so future `send` calls throw.
		wsA.__wedge();

		// Trigger a presence_added broadcast by connecting a third install.
		const wsC = await upgrade(room, 'C');

		// A's wedged socket recorded nothing past wedging, but B must have
		// received the presence_added for C.
		const bFrames = presenceFrames(wsB);
		expect(bFrames.find((f) => f.type === 'presence_added' && f.install === 'C')).toBeDefined();

		// C's own snapshot saw A and B (snapshot was sent BEFORE the broadcast,
		// and the wedge only affects future sends to A).
		const cFrames = presenceFrames(wsC);
		expect(cFrames[0]).toEqual({
			type: 'presence_snapshot',
			installs: ['A', 'B'],
		});
	});
});
