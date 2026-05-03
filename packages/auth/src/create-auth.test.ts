/**
 * Core Auth Snapshot API Tests
 *
 * Verifies the public snapshot listener and initial load barrier exposed by
 * the framework-agnostic auth client.
 *
 * Key behaviors:
 * - Session storage is a boot cache that loads once and saves local updates
 * - Better Auth session emissions drive live signed-in and signed-out state
 * - whenLoaded resolves after storage load settles, including null and errors
 */

import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { AuthSession, AuthSnapshot } from './index.ts';
import type { SessionStorage } from './session-store.ts';

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
let betterAuthClientOptions: BetterAuthClientOptions | null = null;
let signInResponseHeaders: Record<string, string> | undefined;

mock.module('better-auth/client', () => ({
	createAuthClient(options: BetterAuthClientOptions) {
		betterAuthClientOptions = options;
		return {
			useSession: {
				subscribe(listener: (state: BetterAuthSessionState) => void) {
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

const { createAuth, createSessionStorageAdapter } = await import(
	'./create-auth.ts'
);

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

beforeEach(() => {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(null), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})) as unknown as typeof fetch;
	console.error = () => {};
	betterAuthSessionListeners = new Set();
	betterAuthClientOptions = null;
	signInResponseHeaders = undefined;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
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
	const storage = {
		load,
		save(value) {
			saved.push(value);
			return save(value);
		},
	} satisfies SessionStorage;

	return {
		storage,
		saved,
	};
}

function createDeferred<T>() {
	let resolve: (value: T) => void = () => {};
	let reject: (error: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function emitBetterAuthSession(data: unknown) {
	for (const listener of betterAuthSessionListeners) {
		listener({ isPending: false, data });
	}
}

async function tick() {
	await Promise.resolve();
	await Promise.resolve();
}

test('onSnapshotChange does not replay and receives future changes only', async () => {
	const setup = createStorage({ load: () => null });
	const auth = createAuth({
		baseURL: 'http://localhost:8787',
		sessionStorage: setup.storage,
	});
	await auth.whenLoaded;

	const snapshots: AuthSnapshot[] = [];
	auth.onSnapshotChange((snapshot) => snapshots.push(snapshot));

	expect(snapshots).toEqual([]);

	emitBetterAuthSession(betterAuthSessionData(session()));

	expect(snapshots).toEqual([{ status: 'signedIn', session: session() }]);
	auth[Symbol.dispose]();
});

test('listener failures do not stop later listeners', async () => {
	const setup = createStorage({ load: () => null });
	const auth = createAuth({
		baseURL: 'http://localhost:8787',
		sessionStorage: setup.storage,
	});
	await auth.whenLoaded;
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

test('persisted storage load drives initial signed-in snapshot', async () => {
	const setup = createStorage({ load: () => session() });
	const auth = createAuth({
		baseURL: 'http://localhost:8787',
		sessionStorage: setup.storage,
	});

	await auth.whenLoaded;

	expect(auth.snapshot).toEqual({ status: 'signedIn', session: session() });
	auth[Symbol.dispose]();
});

test('whenLoaded resolves after asynchronous signed-out storage load settles', async () => {
	const deferred = createDeferred<AuthSession | null>();
	const setup = createStorage({ load: () => deferred.promise });
	const auth = createAuth({
		baseURL: 'http://localhost:8787',
		sessionStorage: setup.storage,
	});
	let loaded = false;
	void auth.whenLoaded.then(() => {
		loaded = true;
	});

	await tick();
	expect(loaded).toBe(false);

	deferred.resolve(null);
	await auth.whenLoaded;

	expect(loaded).toBe(true);
	expect(auth.snapshot).toEqual({ status: 'signedOut' });
	auth[Symbol.dispose]();
});

test('whenLoaded resolves after storage load failure and normalizes to signed out', async () => {
	const deferred = createDeferred<AuthSession | null>();
	const setup = createStorage({ load: () => deferred.promise });
	const auth = createAuth({
		baseURL: 'http://localhost:8787',
		sessionStorage: setup.storage,
	});

	deferred.reject(new Error('load failed'));
	await auth.whenLoaded;

	expect(auth.snapshot).toEqual({ status: 'signedOut' });
	auth[Symbol.dispose]();
});

test('dispose is idempotent and unsubscribes from Better Auth once', async () => {
	const setup = createStorage({
		load: () => null,
	});
	const auth = createAuth({
		baseURL: 'http://localhost:8787',
		sessionStorage: setup.storage,
	});
	await auth.whenLoaded;
	expect(betterAuthSessionListeners.size).toBe(1);

	auth[Symbol.dispose]();
	auth[Symbol.dispose]();

	expect(betterAuthSessionListeners.size).toBe(0);
});

test('dispose resolves whenLoaded and ignores late storage load', async () => {
	const deferred = createDeferred<AuthSession | null>();
	const setup = createStorage({ load: () => deferred.promise });
	const auth = createAuth({
		baseURL: 'http://localhost:8787',
		sessionStorage: setup.storage,
	});

	auth[Symbol.dispose]();
	await auth.whenLoaded;
	deferred.resolve(session());
	await tick();

	expect(auth.snapshot).toEqual({ status: 'loading' });
});

test('Better Auth signed-in emission drives snapshot and storage save', async () => {
	const setup = createStorage({ load: () => null });
	const auth = createAuth({
		baseURL: 'http://localhost:8787',
		sessionStorage: setup.storage,
	});
	await auth.whenLoaded;

	emitBetterAuthSession(betterAuthSessionData(session()));

	expect(auth.snapshot).toEqual({ status: 'signedIn', session: session() });
	expect(setup.saved).toEqual([session()]);
	auth[Symbol.dispose]();
});

test('Better Auth signed-out emission drives snapshot and storage save', async () => {
	const setup = createStorage({ load: () => session() });
	const auth = createAuth({
		baseURL: 'http://localhost:8787',
		sessionStorage: setup.storage,
	});
	await auth.whenLoaded;

	emitBetterAuthSession(null);

	expect(auth.snapshot).toEqual({ status: 'signedOut' });
	expect(setup.saved).toEqual([null]);
	auth[Symbol.dispose]();
});

test('Better Auth emission during async load is applied after boot cache settles', async () => {
	const deferred = createDeferred<AuthSession | null>();
	const setup = createStorage({ load: () => deferred.promise });
	const auth = createAuth({
		baseURL: 'http://localhost:8787',
		sessionStorage: setup.storage,
	});

	emitBetterAuthSession(
		betterAuthSessionData(session({ token: 'better-auth-token' })),
	);
	deferred.resolve(null);
	await auth.whenLoaded;

	const expected = session({ token: 'better-auth-token' });
	expect(auth.snapshot).toEqual({ status: 'signedIn', session: expected });
	expect(setup.saved).toEqual([expected]);
	auth[Symbol.dispose]();
});

test('response-header token rotation persists through session storage save', async () => {
	const setup = createStorage({ load: () => session({ token: 'old-token' }) });
	const auth = createAuth({
		baseURL: 'http://localhost:8787',
		sessionStorage: setup.storage,
	});
	await auth.whenLoaded;

	signInResponseHeaders = { 'set-auth-token': 'new-token' };
	await auth.signIn({ email: 'user@example.com', password: 'password' });

	const expected = session({ token: 'new-token' });
	expect(auth.snapshot).toEqual({ status: 'signedIn', session: expected });
	expect(setup.saved).toEqual([expected]);
	expect(betterAuthClientOptions).not.toBeNull();
	auth[Symbol.dispose]();
});

test('session storage adapter delegates load and save to wrapped state', async () => {
	let current: AuthSession | null = null;
	let ready = false;
	const adapter = createSessionStorageAdapter({
		get: () => current,
		set: (value) => {
			current = value;
		},
		whenReady: Promise.resolve().then(() => {
			ready = true;
		}),
	});

	expect(await adapter.load()).toBeNull();
	expect(ready).toBe(true);

	const next = session();
	await adapter.save(next);
	await expect(adapter.load()).resolves.toEqual(next);
	expect('watch' in adapter).toBe(false);
});
