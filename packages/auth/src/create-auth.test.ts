/**
 * Core Auth Snapshot API Tests
 *
 * Verifies the public snapshot listener and initial load barrier exposed by
 * the framework-agnostic auth client.
 *
 * Key behaviors:
 * - Caller-provided initial sessions seed the first snapshot
 * - Local updates are passed to the caller-provided save callback
 * - Better Auth session emissions drive live signed-in and signed-out state
 */

import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { AuthSession, AuthSnapshot } from './index.ts';

type BetterAuthSessionState = {
	isPending: boolean;
	data: unknown;
};

type BetterAuthClientOptions = {
	fetchOptions?: {
		onSuccess?: (context: { response: Response }) => void;
	};
};

let betterAuthSessionListeners = new Set<
	(state: BetterAuthSessionState) => void
>();
let currentBetterAuthState: BetterAuthSessionState = {
	isPending: false,
	data: null,
};
let betterAuthClientOptions: BetterAuthClientOptions | null = null;
let signInResponseHeaders: Record<string, string> | undefined;
let capturedWebSockets: FakeWebSocket[] = [];

mock.module('better-auth/client', () => ({
	createAuthClient(options: BetterAuthClientOptions) {
		betterAuthClientOptions = options;
		return {
			useSession: {
				subscribe(listener: (state: BetterAuthSessionState) => void) {
					// Match nanostore semantics: the atom replays the current
					// value to a new subscriber synchronously before adding
					// it to the listener set.
					listener(currentBetterAuthState);
					betterAuthSessionListeners.add(listener);
					return () => {
						betterAuthSessionListeners.delete(listener);
					};
				},
			},
			signIn: {
				email: async () => {
					if (signInResponseHeaders) {
						options.fetchOptions?.onSuccess?.({
							response: new Response(null, {
								headers: signInResponseHeaders,
							}),
						});
					}
					return { error: null };
				},
				social: async () => ({ error: null }),
			},
			signUp: {
				email: async () => ({ error: null }),
			},
			signOut: async () => ({ error: null }),
		};
	},
	InferPlugin: () => ({}),
}));

const { createAuth } = await import('./create-auth.ts');

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalConsoleError = console.error;

class FakeWebSocket {
	readonly readyState = 0;

	constructor(
		readonly url: string | URL,
		readonly protocols?: string | string[],
	) {
		capturedWebSockets.push(this);
	}

	close() {}
}

beforeEach(() => {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(null), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})) as unknown as typeof fetch;
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	console.error = () => {};
	betterAuthSessionListeners = new Set();
	currentBetterAuthState = { isPending: false, data: null };
	betterAuthClientOptions = null;
	signInResponseHeaders = undefined;
	capturedWebSockets = [];
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	globalThis.WebSocket = originalWebSocket;
	console.error = originalConsoleError;
});

function session({
	userId = 'user-1',
	token = 'token-1',
}: {
	userId?: string;
	token?: string;
} = {}): AuthSession {
	return {
		token,
		user: {
			id: userId,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			email: `${userId}@example.com`,
			emailVerified: true,
			name: userId,
			image: null,
		},
		encryptionKeys: [
			{
				version: 1,
				userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
			},
		],
	};
}

function betterAuthSessionData(value: AuthSession) {
	return {
		user: value.user,
		session: {
			id: 'session-1',
			token: value.token,
			userId: value.user.id,
			expiresAt: '2026-02-01T00:00:00.000Z',
			createdAt: value.user.createdAt,
			updatedAt: value.user.updatedAt,
			ipAddress: null,
			userAgent: null,
		},
		encryptionKeys: value.encryptionKeys,
	};
}

function createStorage({
	load,
	save = () => {},
}: {
	load: () => AuthSession | null | Promise<AuthSession | null>;
	save?: (value: AuthSession | null) => void | Promise<void>;
}) {
	const saved: Array<AuthSession | null> = [];
	const loaded = load();
	const initialSession = loaded instanceof Promise ? null : loaded;
	const storage = {
		load,
		save(value: AuthSession | null) {
			saved.push(value);
			return save(value);
		},
	};

	return {
		storage,
		initialSession,
		saved,
	};
}

function createTestAuth(setup: ReturnType<typeof createStorage>) {
	return createAuth({
		baseURL: 'http://localhost:8787',
		initialSession: setup.initialSession,
		saveSession: setup.storage.save,
	});
}

function emitBetterAuthSession(data: unknown) {
	currentBetterAuthState = { isPending: false, data };
	for (const listener of betterAuthSessionListeners) {
		listener(currentBetterAuthState);
	}
}

test('onSnapshotChange does not replay and receives future changes only', async () => {
	const setup = createStorage({ load: () => null });
	const auth = createTestAuth(setup);

	const snapshots: AuthSnapshot[] = [];
	auth.onSnapshotChange((snapshot) => snapshots.push(snapshot));

	expect(snapshots).toEqual([]);

	emitBetterAuthSession(betterAuthSessionData(session()));

	expect(snapshots).toEqual([{ status: 'signedIn', session: session() }]);
	auth[Symbol.dispose]();
});

test('listener failures do not stop later listeners', async () => {
	const setup = createStorage({ load: () => null });
	const auth = createTestAuth(setup);
	const snapshots: AuthSnapshot[] = [];

	auth.onSnapshotChange(() => {
		throw new Error('listener failed');
	});
	auth.onSnapshotChange((snapshot) => snapshots.push(snapshot));

	emitBetterAuthSession(
		betterAuthSessionData(session({ token: 'token-2' })),
	);

	expect(snapshots).toEqual([
		{ status: 'signedIn', session: session({ token: 'token-2' }) },
	]);
	auth[Symbol.dispose]();
});

test('initial session drives initial signed-in snapshot', async () => {
	// Seed the BA atom so the late subscribe replays the matching session
	// instead of the default null (which would flip the snapshot to signedOut).
	emitBetterAuthSession(betterAuthSessionData(session()));
	const setup = createStorage({ load: () => session() });
	const auth = createTestAuth(setup);


	expect(auth.snapshot).toEqual({ status: 'signedIn', session: session() });
	auth[Symbol.dispose]();
});

test('whenReady and whenLoaded share the first settled session barrier', async () => {
	currentBetterAuthState = { isPending: true, data: null };
	const setup = createStorage({ load: () => null });
	const auth = createTestAuth(setup);
	let ready = false;

	expect(auth.whenReady).toBe(auth.whenLoaded);
	void auth.whenReady.then(() => {
		ready = true;
	});
	await Promise.resolve();
	expect(ready).toBe(false);

	emitBetterAuthSession(null);
	await auth.whenReady;

	expect(ready).toBe(true);
	auth[Symbol.dispose]();
});

test('openWebSocket returns null signed out and adds bearer subprotocol signed in', async () => {
	const setup = createStorage({ load: () => null });
	const auth = createTestAuth(setup);

	expect(auth.openWebSocket('ws://localhost/sync')).toBeNull();

	emitBetterAuthSession(betterAuthSessionData(session({ token: 'token-2' })));
	const ws = auth.openWebSocket('ws://localhost/sync');

	expect(ws).toBe(capturedWebSockets[0] as unknown as WebSocket);
	expect(capturedWebSockets[0]).toMatchObject({
		url: 'ws://localhost/sync',
		protocols: ['epicenter', 'bearer.token-2'],
	});
	auth[Symbol.dispose]();
});

test('dispose is idempotent and unsubscribes from Better Auth once', async () => {
	const setup = createStorage({
		load: () => null,
	});
	const auth = createTestAuth(setup);
	expect(betterAuthSessionListeners.size).toBe(1);

	auth[Symbol.dispose]();
	auth[Symbol.dispose]();

	expect(betterAuthSessionListeners.size).toBe(0);
});

test('Better Auth signed-in emission drives snapshot and storage save', async () => {
	const setup = createStorage({ load: () => null });
	const auth = createTestAuth(setup);

	emitBetterAuthSession(betterAuthSessionData(session()));

	expect(auth.snapshot).toEqual({ status: 'signedIn', session: session() });
	expect(setup.saved).toEqual([session()]);
	auth[Symbol.dispose]();
});

test('Better Auth signed-out emission drives snapshot and storage save', async () => {
	// Seed the BA atom with the matching session so the late subscribe
	// replays as a no-op transition; the explicit null emission below is
	// then the only event that drives the signedIn -> signedOut switch.
	emitBetterAuthSession(betterAuthSessionData(session()));
	const setup = createStorage({ load: () => session() });
	const auth = createTestAuth(setup);
	// Drop the redundant save fired by writeLocalSnapshot during the
	// subscribe replay so the assertion below isolates the explicit emit.
	setup.saved.length = 0;

	emitBetterAuthSession(null);

	expect(auth.snapshot).toEqual({ status: 'signedOut' });
	expect(setup.saved).toEqual([null]);
	auth[Symbol.dispose]();
});

test('response-header token rotation persists through session storage save', async () => {
	// Seed the BA atom so the late subscribe replays the same session as the
	// initial session; without this, the default null replay would flip the
	// snapshot to signedOut and the rotation hook below would not fire.
	emitBetterAuthSession(
		betterAuthSessionData(session({ token: 'old-token' })),
	);
	const setup = createStorage({ load: () => session({ token: 'old-token' }) });
	const auth = createTestAuth(setup);
	// Drop the redundant save fired by writeLocalSnapshot during the
	// subscribe replay so the assertion below isolates the rotation save.
	setup.saved.length = 0;

	signInResponseHeaders = { 'set-auth-token': 'new-token' };
	await auth.signIn({ email: 'user@example.com', password: 'password' });

	const expected = session({ token: 'new-token' });
	expect(auth.snapshot).toEqual({ status: 'signedIn', session: expected });
	expect(setup.saved).toEqual([expected]);
	expect(betterAuthClientOptions).not.toBeNull();
	auth[Symbol.dispose]();
});
