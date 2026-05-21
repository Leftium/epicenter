/**
 * Cloud Workspace Sync Tests
 *
 * Verifies the app-scoped `cloudWorkspaceSync.forApp` factory and the legacy
 * resolution helpers that the factory replaces.
 *
 * Key behaviors:
 * - Signed-out and reauth-required auth states do not call the Workspace API.
 * - Failed or malformed Workspace API responses return no URL.
 * - The factory fetches `/api/workspaces` once for N child docs.
 * - The factory reconnects live handles when auth transitions to signed-in.
 * - The factory rejects non-route-safe doc ids synchronously at the call site.
 * - A 409 from `/api/workspaces` surfaces as `personal-workspace-missing`.
 */

import { describe, expect, test } from 'bun:test';
import type { AuthClient, AuthState, LocalIdentity } from '@epicenter/auth';
import * as Y from 'yjs';
import {
	cloudWorkspaceSync,
	resolveDefaultCloudWorkspaceId,
	type CloudWorkspaceLookupFailure,
	type DefaultCloudWorkspaceAuth,
} from './cloud-workspace-sync.js';

const localIdentity: LocalIdentity = {
	subject: 'user_1',
	keyring: [
		{
			version: 1,
			subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
	],
};

function authHarness({
	state = { status: 'signed-in', localIdentity },
	response = Response.json({ defaultWorkspaceId: 'ws_123' }),
	throwOnFetch = false,
}: {
	state?: AuthState;
	response?: Response;
	throwOnFetch?: boolean;
} = {}) {
	const fetches: string[] = [];
	const auth: DefaultCloudWorkspaceAuth = {
		state,
		async fetch(input: Request | string | URL) {
			fetches.push(String(input));
			if (throwOnFetch) throw new Error('offline');
			return response;
		},
	};
	return { auth, fetches };
}

describe('resolveDefaultCloudWorkspaceId', () => {
	test('signed out returns undefined without fetching', async () => {
		const { auth, fetches } = authHarness({ state: { status: 'signed-out' } });

		await expect(resolveDefaultCloudWorkspaceId(auth)).resolves.toBeUndefined();
		expect(fetches).toEqual([]);
	});

	test('reauth-required returns undefined without fetching', async () => {
		const { auth, fetches } = authHarness({
			state: { status: 'reauth-required', localIdentity },
		});

		await expect(resolveDefaultCloudWorkspaceId(auth)).resolves.toBeUndefined();
		expect(fetches).toEqual([]);
	});

	test('offline fetch returns undefined', async () => {
		const { auth } = authHarness({ throwOnFetch: true });

		await expect(resolveDefaultCloudWorkspaceId(auth)).resolves.toBeUndefined();
	});

	test('/api/workspaces non-ok returns undefined', async () => {
		const { auth } = authHarness({
			response: new Response(null, { status: 500 }),
		});

		await expect(resolveDefaultCloudWorkspaceId(auth)).resolves.toBeUndefined();
	});

	test('missing defaultWorkspaceId returns undefined', async () => {
		const { auth } = authHarness({ response: Response.json({}) });

		await expect(resolveDefaultCloudWorkspaceId(auth)).resolves.toBeUndefined();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// cloudWorkspaceSync.forApp
// ════════════════════════════════════════════════════════════════════════════

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

describe('cloudWorkspaceSync.forApp', () => {
	test('opening N docs hits /api/workspaces exactly once', async () => {
		const { auth, fetches, openedSocketUrls } = createFactoryAuthHarness();

		const sync = cloudWorkspaceSync.forApp({
			auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
		});

		const docs = Array.from({ length: 5 }, (_, i) => new Y.Doc({ guid: `entry.${i}.body` }));
		for (const ydoc of docs) {
			sync.open(ydoc, { installationId: 'install-1', actions: {} });
		}

		await tick();

		expect(fetches).toEqual(['/api/workspaces']);
		expect(openedSocketUrls).toHaveLength(5);
		// First doc should have built the URL with its guid as docId.
		expect(openedSocketUrls[0]).toMatch(
			/^wss:\/\/api\.example\.com\/workspaces\/ws_123\/apps\/fuji\/docs\/entry\.0\.body\?installationId=install-1$/,
		);
	});

	test('valid docId passes through to the URL verbatim (no encoding)', async () => {
		const { auth, openedSocketUrls } = createFactoryAuthHarness();

		const sync = cloudWorkspaceSync.forApp({
			auth,
			apiUrl: 'https://api.example.com',
			appId: 'honeycrisp',
		});

		const ydoc = new Y.Doc({ guid: 'irrelevant' });
		sync.open(ydoc, {
			docId: 'note.01HVXYZ.body',
			installationId: 'install-1',
			actions: {},
		});

		await tick();

		expect(openedSocketUrls[0]).toContain(
			'/workspaces/ws_123/apps/honeycrisp/docs/note.01HVXYZ.body',
		);
	});

	test('invalid docId throws synchronously at open() with allowed alphabet quoted', () => {
		const { auth } = createFactoryAuthHarness();
		const sync = cloudWorkspaceSync.forApp({
			auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
		});

		const ydoc = new Y.Doc({ guid: 'root' });

		expect(() =>
			sync.open(ydoc, {
				docId: 'entry/1',
				installationId: 'install-1',
				actions: {},
			}),
		).toThrow(/Invalid docId "entry\/1"/);
		expect(() =>
			sync.open(ydoc, {
				docId: 'entry/1',
				installationId: 'install-1',
				actions: {},
			}),
		).toThrow(/\[A-Za-z0-9\._-\]/);
	});

	test('docId defaults to ydoc.guid', async () => {
		const { auth, openedSocketUrls } = createFactoryAuthHarness();
		const sync = cloudWorkspaceSync.forApp({
			auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
		});

		const ydoc = new Y.Doc({ guid: 'root' });
		sync.open(ydoc, { installationId: 'install-1', actions: {} });

		await tick();

		expect(openedSocketUrls[0]).toContain('/docs/root');
	});

	test('signed-out construction skips /api/workspaces; sign-in triggers attach', async () => {
		const harness = createFactoryAuthHarness({
			initialState: { status: 'signed-out' },
		});

		const sync = cloudWorkspaceSync.forApp({
			auth: harness.auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
		});

		const ydoc = new Y.Doc({ guid: 'root' });
		const handle = sync.open(ydoc, {
			installationId: 'install-1',
			actions: {},
		});

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

	test('409 PersonalWorkspaceMissing surfaces as a hard lookupFailure', async () => {
		const harness = createFactoryAuthHarness({
			workspacesResponse: () =>
				Response.json(
					{ name: 'PersonalWorkspaceMissing', message: 'missing' },
					{ status: 409 },
				),
		});

		const sync = cloudWorkspaceSync.forApp({
			auth: harness.auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
		});

		const failures: Array<CloudWorkspaceLookupFailure | null> = [];
		sync.onLookupFailureChange((failure) => failures.push(failure));

		const ydoc = new Y.Doc({ guid: 'root' });
		sync.open(ydoc, { installationId: 'install-1', actions: {} });

		await tick();

		expect(sync.lookupFailure).toBe('personal-workspace-missing');
		expect(failures).toEqual(['personal-workspace-missing']);
		expect(harness.openedSocketUrls).toEqual([]);
	});

	test('network failure surfaces as a transient lookupFailure', async () => {
		const harness = createFactoryAuthHarness({
			workspacesResponse: () => new Response(null, { status: 500 }),
		});

		const sync = cloudWorkspaceSync.forApp({
			auth: harness.auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
		});

		const ydoc = new Y.Doc({ guid: 'root' });
		sync.open(ydoc, { installationId: 'install-1', actions: {} });

		await tick();

		expect(sync.lookupFailure).toBe('network');
	});

	test('sign-out clears lookupFailure (signed-out is not a failure)', async () => {
		const harness = createFactoryAuthHarness({
			workspacesResponse: () =>
				Response.json(
					{ name: 'PersonalWorkspaceMissing', message: 'missing' },
					{ status: 409 },
				),
		});

		const sync = cloudWorkspaceSync.forApp({
			auth: harness.auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
		});

		const ydoc = new Y.Doc({ guid: 'root' });
		sync.open(ydoc, { installationId: 'install-1', actions: {} });

		await tick();
		expect(sync.lookupFailure).toBe('personal-workspace-missing');

		harness.transition({ status: 'signed-out' });
		await tick();

		expect(sync.lookupFailure).toBeNull();
	});

	test('dispatch() before attach resolves to NetworkFailed', async () => {
		// Signed-out at construction: no URL ever resolves, no underlying
		// collaboration attaches. dispatch() must surface the disconnection
		// rather than throwing or hanging.
		const harness = createFactoryAuthHarness({
			initialState: { status: 'signed-out' },
		});

		const sync = cloudWorkspaceSync.forApp({
			auth: harness.auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
		});

		const ydoc = new Y.Doc({ guid: 'root' });
		const handle = sync.open(ydoc, {
			installationId: 'install-1',
			actions: {},
		});

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
		const sync = cloudWorkspaceSync.forApp({
			auth,
			apiUrl: 'https://api.example.com',
			appId: 'fuji',
		});

		const ydoc = new Y.Doc({ guid: 'root' });

		// Pre-defineActions-style key check fires before any handler runs;
		// the action value shape is irrelevant for this assertion.
		const badRegistry = { 'Bad-Key': async () => undefined } as unknown as Parameters<
			typeof sync.open
		>[1]['actions'];
		expect(() =>
			sync.open(ydoc, {
				installationId: 'install-1',
				actions: badRegistry,
			}),
		).toThrow(/Invalid action key/);
	});
});
