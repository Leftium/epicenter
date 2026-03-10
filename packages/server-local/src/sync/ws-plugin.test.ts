/**
 * WS Sync Plugin Integration Tests
 *
 * Tests the full WebSocket sync flow using real Hono servers
 * and real sync providers over actual WebSocket connections.
 *
 * These tests verify the wiring between the Hono app, room manager,
 * auth, and protocol layers — the exact integration path clients use.
 * Unit tests for individual building blocks live in their respective files.
 *
 * Co-located with plugin.ts for easy discovery.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SyncProvider, SyncStatus } from '@epicenter/sync-client';
import { createSyncProvider } from '@epicenter/sync-client';
import { Hono } from 'hono';
import * as Y from 'yjs';
import { createWsSyncPlugin } from './ws-plugin';

// ============================================================================
// Test Utilities
// ============================================================================

let counter = 0;

/** Generate a unique room ID per test to avoid cross-test state bleed. */
function uniqueRoom(): string {
	return `test-room-${Date.now()}-${counter++}`;
}

/** Convert an HTTP URL to a WebSocket URL. */
function wsUrl(httpUrl: string): string {
	return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

/**
 * Start a test server on a random port (port 0).
 *
 * Uses the sync plugin directly (no createLocalServer dependency)
 * to keep the test self-contained without cyclic deps.
 */
function startTestServer(syncConfig?: {
	verifyToken?: (token: string) => boolean | Promise<boolean>;
}) {
	const { syncApp, websocket } = createWsSyncPlugin(syncConfig);
	const app = new Hono();
	app.route('/rooms', syncApp);
	app.get('/', (c) => c.json({ status: 'ok' }));
	const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
	const port = server.port;
	return {
		server: {
			async stop() {
				server.stop();
			},
		},
		port,
		wsUrl(room: string) {
			return `ws://localhost:${port}/rooms/${room}`;
		},
		httpUrl(path = '/') {
			return `http://localhost:${port}${path}`;
		},
	};
}

function startIntegratedTestServer({
	getDoc,
}: {
	getDoc: (roomId: string) => Y.Doc | undefined;
}) {
	const { syncApp, websocket } = createWsSyncPlugin({ getDoc });
	const app = new Hono();
	app.route('/', syncApp);
	app.get('/', (c) => c.json({ status: 'ok' }));
	const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
	const port = server.port;
	return {
		server,
		port,
		wsUrl(room: string) {
			return `ws://localhost:${port}/${room}`;
		},
		httpUrl(path = '/') {
			return `http://localhost:${port}${path}`;
		},
	};
}

/**
 * Wait for a sync provider to reach a specific status.
 *
 * Subscribes to changes BEFORE checking the current value to prevent
 * a race where the status transitions between the check and subscription.
 * Rejects after timeout to prevent hanging tests.
 */
function waitForStatus(
	provider: SyncProvider,
	target: SyncStatus,
	timeoutMs = 5_000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsub();
			reject(
				new Error(
					`Timed out waiting for status '${target}', stuck at '${provider.status}'`,
				),
			);
		}, timeoutMs);
		const unsub = provider.onStatusChange((s) => {
			if (s === target) {
				clearTimeout(timer);
				unsub();
				resolve();
			}
		});
		// Check AFTER subscribing to close the race window
		if (provider.status === target) {
			clearTimeout(timer);
			unsub();
			resolve();
		}
	});
}

/**
 * Wait for a Y.Map key to appear in a document.
 *
 * Subscribes to doc updates BEFORE checking the current value to prevent
 * a race where the update arrives between the check and subscription.
 * Uses doc.on('update') to detect changes — event-driven, no polling.
 */
function waitForMapKey(
	doc: Y.Doc,
	mapName: string,
	key: string,
	timeoutMs = 5_000,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			doc.off('update', handler);
			reject(new Error(`Timed out waiting for ${mapName}.${key}`));
		}, timeoutMs);
		const handler = () => {
			const val = doc.getMap(mapName).get(key);
			if (val !== undefined) {
				clearTimeout(timer);
				doc.off('update', handler);
				resolve(val);
			}
		};
		// Subscribe BEFORE checking to close the race window
		doc.on('update', handler);
		const current = doc.getMap(mapName).get(key);
		if (current !== undefined) {
			clearTimeout(timer);
			doc.off('update', handler);
			resolve(current);
		}
	});
}


// ============================================================================
// Document Sync Tests
// ============================================================================

describe('ws sync plugin integration', () => {
	let ctx: ReturnType<typeof startTestServer>;

	beforeAll(() => {
		ctx = startTestServer();
	});

	afterAll(async () => {
		await ctx.server.stop();
	});

	test('health endpoint returns status', async () => {
		const res = await fetch(ctx.httpUrl('/'));
		const body = await res.json();
		expect(body).toEqual({ status: 'ok' });
	});

	test('two clients sync document updates', async () => {
		const room = uniqueRoom();
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();

		const p1 = createSyncProvider({ doc: doc1, url: wsUrl(ctx.httpUrl('/rooms/' + room)) });
		p1.connect();
		const p2 = createSyncProvider({ doc: doc2, url: wsUrl(ctx.httpUrl('/rooms/' + room)) });
		p2.connect();

		try {
			await waitForStatus(p1, 'connected');
			await waitForStatus(p2, 'connected');

			doc1.getMap('data').set('hello', 'world');

			const value = await waitForMapKey(doc2, 'data', 'hello');
			expect(value).toBe('world');
		} finally {
			p1.destroy();
			p2.destroy();
		}
	});

	test('sender does not receive its own updates', async () => {
		const room = uniqueRoom();
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();

		const p1 = createSyncProvider({ doc: doc1, url: wsUrl(ctx.httpUrl('/rooms/' + room)) });
		p1.connect();
		const p2 = createSyncProvider({ doc: doc2, url: wsUrl(ctx.httpUrl('/rooms/' + room)) });
		p2.connect();

		try {
			await waitForStatus(p1, 'connected');
			await waitForStatus(p2, 'connected');

			doc1.getMap('data').set('from-client-1', 'client-1-value');

			const valueOnClient2 = await waitForMapKey(doc2, 'data', 'from-client-1');
			expect(valueOnClient2).toBe('client-1-value');

			expect(doc1.getMap('data').get('from-client-1')).toBe('client-1-value');
		} finally {
			p1.destroy();
			p2.destroy();
		}
	});

	test('bidirectional sync merges concurrent edits', async () => {
		const room = uniqueRoom();
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();

		const p1 = createSyncProvider({ doc: doc1, url: wsUrl(ctx.httpUrl('/rooms/' + room)) });
		p1.connect();
		const p2 = createSyncProvider({ doc: doc2, url: wsUrl(ctx.httpUrl('/rooms/' + room)) });
		p2.connect();

		try {
			await waitForStatus(p1, 'connected');
			await waitForStatus(p2, 'connected');

			doc1.getMap('data').set('from1', 'value1');
			doc2.getMap('data').set('from2', 'value2');

			await waitForMapKey(doc1, 'data', 'from2');
			await waitForMapKey(doc2, 'data', 'from1');

			expect(doc1.getMap('data').get('from1')).toBe('value1');
			expect(doc1.getMap('data').get('from2')).toBe('value2');
			expect(doc2.getMap('data').get('from1')).toBe('value1');
			expect(doc2.getMap('data').get('from2')).toBe('value2');
		} finally {
			p1.destroy();
			p2.destroy();
		}
	});

	test('late joiner receives existing document state', async () => {
		const room = uniqueRoom();
		const doc1 = new Y.Doc();

		const p1 = createSyncProvider({ doc: doc1, url: wsUrl(ctx.httpUrl('/rooms/' + room)) });
		p1.connect();

		try {
			await waitForStatus(p1, 'connected');

			doc1.getMap('data').set('existing', 'content');

			// Small delay for server to process the update
			await new Promise((r) => setTimeout(r, 50));

			const doc2 = new Y.Doc();
			const p2 = createSyncProvider({ doc: doc2, url: wsUrl(ctx.httpUrl('/rooms/' + room)) });
			p2.connect();

			try {
				await waitForStatus(p2, 'connected');

				const value = await waitForMapKey(doc2, 'data', 'existing');
				expect(value).toBe('content');
			} finally {
				p2.destroy();
			}
		} finally {
			p1.destroy();
		}
	});

	test('rooms are isolated from each other', async () => {
		const roomA = uniqueRoom();
		const roomB = uniqueRoom();
		const docA1 = new Y.Doc();
		const docA2 = new Y.Doc();
		const docB = new Y.Doc();

		const pA1 = createSyncProvider({ doc: docA1, url: wsUrl(ctx.httpUrl('/rooms/' + roomA)) });
		pA1.connect();
		const pA2 = createSyncProvider({ doc: docA2, url: wsUrl(ctx.httpUrl('/rooms/' + roomA)) });
		pA2.connect();
		const pB = createSyncProvider({ doc: docB, url: wsUrl(ctx.httpUrl('/rooms/' + roomB)) });
		pB.connect();

		try {
			await waitForStatus(pA1, 'connected');
			await waitForStatus(pA2, 'connected');
			await waitForStatus(pB, 'connected');

			docA1.getMap('data').set('secret', 'room-a-only');

			// Positive: A2 (same room) MUST receive the update — proves relay works
			const value = await waitForMapKey(docA2, 'data', 'secret');
			expect(value).toBe('room-a-only');

			// Negative: B (different room) must NOT have received it.
			// Since A2 already got it, any cross-room leak would have arrived too.
			expect(docB.getMap('data').get('secret')).toBeUndefined();
		} finally {
			pA1.destroy();
			pA2.destroy();
			pB.destroy();
		}
	});

});

describe('ws sync plugin integrated mode', () => {
	test('never connects when getDoc returns undefined (4004 close)', async () => {
		const ctx = startIntegratedTestServer({ getDoc: () => undefined });
		const room = uniqueRoom();
		const doc = new Y.Doc();
		const provider = createSyncProvider({
			doc,
			url: wsUrl(ctx.httpUrl('/rooms/' + room)),
		});
		provider.connect();

		try {
			// Collect statuses — the provider should cycle connecting/offline but never reach connected
			const statuses: SyncStatus[] = [];
			const unsub = provider.onStatusChange((s) => statuses.push(s));
			await new Promise((r) => setTimeout(r, 1_000));
			unsub();

			expect(statuses).not.toContain('connected');
		} finally {
			provider.destroy();
			ctx.server.stop();
		}
	});
});

// ============================================================================
// Room List Tests
// ============================================================================

describe('ws sync plugin room list', () => {
	test('returns empty rooms array when no rooms are active', async () => {
		const ctx = startTestServer();

		try {
			const res = await fetch(ctx.httpUrl('/rooms'));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ rooms: [] });
		} finally {
			await ctx.server.stop();
		}
	});

	test('returns room with connection count after one client connects', async () => {
		const ctx = startTestServer();
		const room = uniqueRoom();
		const doc = new Y.Doc();
		const provider = createSyncProvider({ doc, url: wsUrl(ctx.httpUrl('/rooms/' + room)) });
		provider.connect();

		try {
			await waitForStatus(provider, 'connected');

			const res = await fetch(ctx.httpUrl('/rooms'));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				rooms: [{ id: room, connections: 1 }],
			});
		} finally {
			provider.destroy();
			await ctx.server.stop();
		}
	});

	test('returns correct connection count after multiple clients connect', async () => {
		const ctx = startTestServer();
		const room = uniqueRoom();
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		const doc3 = new Y.Doc();
		const p1 = createSyncProvider({ doc: doc1, url: wsUrl(ctx.httpUrl('/rooms/' + room)) });
		p1.connect();
		const p2 = createSyncProvider({ doc: doc2, url: wsUrl(ctx.httpUrl('/rooms/' + room)) });
		p2.connect();
		const p3 = createSyncProvider({ doc: doc3, url: wsUrl(ctx.httpUrl('/rooms/' + room)) });
		p3.connect();

		try {
			await waitForStatus(p1, 'connected');
			await waitForStatus(p2, 'connected');
			await waitForStatus(p3, 'connected');

			const res = await fetch(ctx.httpUrl('/rooms'));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				rooms: [{ id: room, connections: 3 }],
			});
		} finally {
			p1.destroy();
			p2.destroy();
			p3.destroy();
			await ctx.server.stop();
		}
	});
});

// ============================================================================
// WS Auth Tests (separate servers per test — different auth configs)
// ============================================================================

describe('ws sync plugin auth', () => {
	/**
	 * Helper to assert a provider never reaches 'connected'.
	 *
	 * Subscribes before connect() so fast auth rejections still emit the
	 * initial 'connecting' transition into the collected status list.
	 */
	async function expectAuthRejection(provider: SyncProvider): Promise<void> {
		const statuses: SyncStatus[] = [];
		const unsub = provider.onStatusChange((s) => statuses.push(s));
		provider.connect();
		await new Promise((r) => setTimeout(r, 1_000));
		unsub();

		// Should have attempted at least one connection cycle
		expect(statuses).toContain('connecting');
		expect(statuses).not.toContain('connected');
	}

	test('rejects connection without token when auth is required', async () => {
		const ctx = startTestServer({ verifyToken: (t: string) => t === 'secret' });

		try {
			const room = uniqueRoom();
			const doc = new Y.Doc();

			const provider = createSyncProvider({
				doc,
				url: wsUrl(ctx.httpUrl('/rooms/' + room)),
			});

			try {
				await expectAuthRejection(provider);
			} finally {
				provider.destroy();
			}
		} finally {
			await ctx.server.stop();
		}
	});

	test('rejects connection with wrong token', async () => {
		const ctx = startTestServer({
			verifyToken: (t: string) => t === 'correct-token',
		});

		try {
			const room = uniqueRoom();
			const doc = new Y.Doc();

			const provider = createSyncProvider({
				doc,
				url: wsUrl(ctx.httpUrl('/rooms/' + room)),
				getToken: async () => 'wrong-token',
			});

			try {
				await expectAuthRejection(provider);
			} finally {
				provider.destroy();
			}
		} finally {
			await ctx.server.stop();
		}
	});

	test('accepts connection with correct token', async () => {
		const ctx = startTestServer({ verifyToken: (t: string) => t === 'secret' });

		try {
			const room = uniqueRoom();
			const doc = new Y.Doc();

			const provider = createSyncProvider({
				doc,
				url: wsUrl(ctx.httpUrl('/rooms/' + room)),
				getToken: async () => 'secret',
			});
			provider.connect();

			try {
				await waitForStatus(provider, 'connected');
				expect(provider.status).toBe('connected');
			} finally {
				provider.destroy();
			}
		} finally {
			await ctx.server.stop();
		}
	});
});
