/**
 * Core Auth Snapshot API Tests
 *
 * Verifies the public snapshot listener and initial load barrier exposed by
 * the framework-agnostic auth client.
 *
 * Key behaviors:
 * - Snapshot change listeners are future-only and do not replay
 * - Subscriber failures do not block later listeners
 * - whenLoaded resolves after storage load settles, including null and errors
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createAuth, createSessionStorageAdapter } from './create-auth.ts';
import type { AuthSession, AuthSnapshot } from './index.ts';
import type { SessionStorage } from './session-store.ts';

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

beforeEach(() => {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(null), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})) as unknown as typeof fetch;
	console.error = () => {};
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

function createStorage({ load }: {
	load: () => AuthSession | null | Promise<AuthSession | null>;
}) {
	let watchCallback: ((next: AuthSession | null) => void) | null = null;
	let unwatchCount = 0;
	const storage = {
		load,
		save() {},
		watch(fn) {
			watchCallback = fn;
			return () => {
				watchCallback = null;
				unwatchCount++;
			};
		},
	} satisfies SessionStorage;

	return {
		storage,
		emit(next: AuthSession | null) {
			watchCallback?.(next);
		},
		get unwatchCount() {
			return unwatchCount;
		},
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

	setup.emit(session());

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

	setup.emit(session({ token: 'token-2' }));

	expect(snapshots).toEqual([
		{ status: 'signedIn', session: session({ token: 'token-2' }) },
	]);
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

test('dispose is idempotent and unsubscribes from session storage once', async () => {
	const setup = createStorage({
		load: () => null,
	});
	const auth = createAuth({
		baseURL: 'http://localhost:8787',
		sessionStorage: setup.storage,
	});
	await auth.whenLoaded;

	auth[Symbol.dispose]();
	auth[Symbol.dispose]();

	expect(setup.unwatchCount).toBe(1);
});

test('storage watch is optional for stores without external updates', async () => {
	const auth = createAuth({
		baseURL: 'http://localhost:8787',
		sessionStorage: {
			load: () => session(),
			save() {},
		},
	});
	await auth.whenLoaded;

	expect(auth.snapshot).toEqual({ status: 'signedIn', session: session() });
	auth[Symbol.dispose]();
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

test('session storage adapter delegates to wrapped state', async () => {
	let current: AuthSession | null = null;
	let watched: ((next: AuthSession | null) => void) | null = null;
	let ready = false;
	const adapter = createSessionStorageAdapter({
		get: () => current,
		set: (value) => {
			current = value;
		},
		watch: (fn) => {
			watched = fn;
			return () => {
				watched = null;
			};
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

	if (!adapter.watch) throw new Error('adapter should expose watch');
	const unsubscribe = adapter.watch(() => {});
	expect(watched).not.toBeNull();
	unsubscribe();
	expect(watched).toBeNull();
});
