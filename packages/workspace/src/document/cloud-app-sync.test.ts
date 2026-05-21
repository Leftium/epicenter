/**
 * openCloudAppSync Tests
 *
 * Key behaviors:
 * - Signed-out construction does not call the Workspace API; signing in
 *   reattaches every live handle.
 * - The factory fetches `/api/workspaces` once for N child docs.
 * - Failed or malformed Workspace API responses keep handles offline; the
 *   factory neither throws nor surfaces structured failure to the caller.
 * - `installationId` is captured at construction and reused for every `.open()`.
 * - `docId` defaults to `ydoc.guid` and is otherwise forwarded verbatim.
 * - `dispatch()` before the underlying collaboration attaches resolves to
 *   `NetworkFailed`.
 * - Action key validation throws synchronously at `.open()`.
 */

import { describe, expect, test } from 'bun:test';
import type { AuthClient, AuthState, LocalIdentity } from '@epicenter/auth';
import * as Y from 'yjs';
import { openCloudAppSync } from './cloud-app-sync.js';

const localIdentity: LocalIdentity = {
	subject: 'user_1',
	keyring: [
		{
			version: 1,
			subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
	],
};

function createFactoryAuthHarness({
	initialState = { status: 'signed-in', localIdentity } as AuthState,
	workspacesResponse = () => Response.json({ defaultWorkspaceId: 'ws_123' }),
}: {
	initialState?: AuthState;
	workspacesResponse?: () => Response;
} = {}) {
	let currentState = initialState;
	const stateListeners = new Set<(state: AuthState) => void>();
	const fetches: string[] = [];
	const openedSocketUrls: string[] = [];

	const auth: AuthClient = {
		get state() {
			return currentState;
		},
		onStateChange(fn) {
			stateListeners.add(fn);
			return () => {
				stateListeners.delete(fn);
			};
		},
		async startSignIn() {
			return { data: undefined, error: null };
		},
		async signOut() {
			return { data: undefined, error: null };
		},
		async fetch(input: Request | string | URL) {
			fetches.push(String(input));
			return workspacesResponse();
		},
		async openWebSocket(url: string | URL) {
			openedSocketUrls.push(String(url));
			// Never resolves: the supervisor sits in connecting. Tests assert on
			// the URL that was offered, not on a fully-connected socket.
			return new Promise<WebSocket>(() => {});
		},
		[Symbol.dispose]() {},
	};

	function transition(next: AuthState) {
		currentState = next;
		for (const listener of stateListeners) listener(next);
	}

	return { auth, fetches, openedSocketUrls, transition };
}

/** Advance one microtask + macrotask so async resolveUrl + setTimeout fire. */
async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('openCloudAppSync', () => {
	test('opening N docs hits /api/workspaces exactly once', async () => {
		const { auth, fetches, openedSocketUrls } = createFactoryAuthHarness();

		const sync = openCloudAppSync({
			auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
			installationId: 'install-1',
		});

		const docs = Array.from(
			{ length: 5 },
			(_, i) => new Y.Doc({ guid: `entry.${i}.body` }),
		);
		for (const ydoc of docs) {
			sync.open(ydoc, { actions: {} });
		}

		await tick();

		expect(fetches).toEqual(['/api/workspaces']);
		expect(openedSocketUrls).toHaveLength(5);
		// First doc should have built the URL with its guid as docId.
		expect(openedSocketUrls[0]).toMatch(
			/^wss:\/\/api\.example\.com\/workspaces\/ws_123\/apps\/fuji\/docs\/entry\.0\.body\?installationId=install-1$/,
		);
		// Every URL carries the factory-captured installationId verbatim.
		for (const url of openedSocketUrls) {
			expect(url).toContain('installationId=install-1');
		}
	});

	test('docId is forwarded verbatim to the URL', async () => {
		const { auth, openedSocketUrls } = createFactoryAuthHarness();

		const sync = openCloudAppSync({
			auth,
			apiUrl: 'https://api.example.com',
			appId: 'honeycrisp',
			installationId: 'install-1',
		});

		const ydoc = new Y.Doc({ guid: 'irrelevant' });
		sync.open(ydoc, {
			docId: 'note.01HVXYZ.body',
			actions: {},
		});

		await tick();

		expect(openedSocketUrls[0]).toContain(
			'/workspaces/ws_123/apps/honeycrisp/docs/note.01HVXYZ.body',
		);
	});

	test('docId defaults to ydoc.guid', async () => {
		const { auth, openedSocketUrls } = createFactoryAuthHarness();
		const sync = openCloudAppSync({
			auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
			installationId: 'install-1',
		});

		const ydoc = new Y.Doc({ guid: 'root' });
		sync.open(ydoc, { actions: {} });

		await tick();

		expect(openedSocketUrls[0]).toContain('/docs/root');
	});

	test('signed-out construction skips /api/workspaces; sign-in triggers attach', async () => {
		const harness = createFactoryAuthHarness({
			initialState: { status: 'signed-out' },
		});

		const sync = openCloudAppSync({
			auth: harness.auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
			installationId: 'install-1',
		});

		const ydoc = new Y.Doc({ guid: 'root' });
		const handle = sync.open(ydoc, { actions: {} });

		await tick();

		// Signed-out: no fetch, no socket opened.
		expect(harness.fetches).toEqual([]);
		expect(harness.openedSocketUrls).toEqual([]);
		expect(handle.status.phase).toBe('offline');

		// Transition to signed-in: factory should refetch and the handle should reattach.
		harness.transition({ status: 'signed-in', localIdentity });
		await tick();

		expect(harness.fetches).toEqual(['/api/workspaces']);
		expect(harness.openedSocketUrls).toHaveLength(1);
	});

	test('500 response keeps handle offline', async () => {
		const harness = createFactoryAuthHarness({
			workspacesResponse: () => new Response(null, { status: 500 }),
		});

		const sync = openCloudAppSync({
			auth: harness.auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
			installationId: 'install-1',
		});

		const ydoc = new Y.Doc({ guid: 'root' });
		const handle = sync.open(ydoc, { actions: {} });

		await tick();

		expect(handle.status.phase).toBe('offline');
		expect(harness.openedSocketUrls).toEqual([]);
	});

	test('transient /api/workspaces failure does not stick; reconnect retries', async () => {
		// A 5xx (or any null-producing) response must not be cached: the next
		// resolve attempt should re-hit /api/workspaces. Without retry, a single
		// network blip during sync bootstrap leaves the handle permanently
		// offline until the user signs out and back in.
		let nthFetch = 0;
		const harness = createFactoryAuthHarness({
			workspacesResponse: () => {
				nthFetch += 1;
				if (nthFetch === 1) return new Response(null, { status: 500 });
				return Response.json({ defaultWorkspaceId: 'ws_123' });
			},
		});

		const sync = openCloudAppSync({
			auth: harness.auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
			installationId: 'install-1',
		});

		const ydoc = new Y.Doc({ guid: 'root' });
		const handle = sync.open(ydoc, { actions: {} });

		await tick();
		expect(handle.status.phase).toBe('offline');
		expect(harness.openedSocketUrls).toEqual([]);

		handle.reconnect();
		await tick();

		expect(harness.fetches).toEqual(['/api/workspaces', '/api/workspaces']);
		expect(harness.openedSocketUrls).toHaveLength(1);
	});

	test('sign-out during in-flight /api/workspaces discards the resolved id', async () => {
		// Race: signed-in -> open() starts the fetch -> user signs out before
		// the response arrives -> response carries a valid workspaceId. Without
		// the post-await re-check, that id would propagate to the handle and
		// the supervisor would open an unauthenticated WebSocket.
		let releaseFetch!: () => void;
		const fetchGate = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});

		let currentState: AuthState = { status: 'signed-in', localIdentity };
		const stateListeners = new Set<(state: AuthState) => void>();
		const openedSocketUrls: string[] = [];
		const auth: AuthClient = {
			get state() {
				return currentState;
			},
			onStateChange(fn) {
				stateListeners.add(fn);
				return () => {
					stateListeners.delete(fn);
				};
			},
			async startSignIn() {
				return { data: undefined, error: null };
			},
			async signOut() {
				return { data: undefined, error: null };
			},
			async fetch() {
				await fetchGate;
				return Response.json({ defaultWorkspaceId: 'ws_123' });
			},
			async openWebSocket(url: string | URL) {
				openedSocketUrls.push(String(url));
				return new Promise<WebSocket>(() => {});
			},
			[Symbol.dispose]() {},
		};

		const sync = openCloudAppSync({
			auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
			installationId: 'install-1',
		});

		const ydoc = new Y.Doc({ guid: 'root' });
		sync.open(ydoc, { actions: {} });
		await tick();

		// Sign out while the fetch is parked at the gate.
		currentState = { status: 'signed-out' };
		for (const listener of stateListeners) listener(currentState);
		await tick();

		// Release the in-flight response carrying a valid workspaceId.
		releaseFetch();
		await tick();
		await tick();

		// No WebSocket is opened: the post-fetch re-check sees signed-out and
		// discards the resolved id.
		expect(openedSocketUrls).toEqual([]);
	});

	test('dispatch() before attach resolves to NetworkFailed', async () => {
		// Signed-out at construction: no URL ever resolves, no underlying
		// collaboration attaches. dispatch() must surface the disconnection
		// rather than throwing or hanging.
		const harness = createFactoryAuthHarness({
			initialState: { status: 'signed-out' },
		});

		const sync = openCloudAppSync({
			auth: harness.auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
			installationId: 'install-1',
		});

		const ydoc = new Y.Doc({ guid: 'root' });
		const handle = sync.open(ydoc, { actions: {} });

		await tick();

		const result = await handle.dispatch({
			to: 'peer-1',
			action: 'noop',
			input: {},
		});

		expect(result.error?.name).toBe('NetworkFailed');
		expect(result.data).toBeNull();
	});

	test('action key validation throws synchronously at open()', () => {
		const { auth } = createFactoryAuthHarness();
		const sync = openCloudAppSync({
			auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
			installationId: 'install-1',
		});

		const ydoc = new Y.Doc({ guid: 'root' });

		// Pre-defineActions-style key check fires before any handler runs;
		// the action value shape is irrelevant for this assertion.
		const badRegistry = {
			'Bad-Key': async () => undefined,
		} as unknown as Parameters<typeof sync.open>[1]['actions'];
		expect(() =>
			sync.open(ydoc, {
				actions: badRegistry,
			}),
		).toThrow(/Invalid action key/);
	});
});
