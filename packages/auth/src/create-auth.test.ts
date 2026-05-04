/**
 * Core Auth Identity API Tests
 *
 * Verifies the public identity listener and initial load barrier exposed by
 * the framework-agnostic auth client.
 *
 * Key behaviors:
 * - Caller-provided initial sessions seed the first identity
 * - Local updates are passed to the caller-provided save callback
 * - Better Auth session emissions drive live signed-in and signed-out state
 */

import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { AuthIdentity, BearerSession } from './index.ts';

type BetterAuthSessionState = {
	isPending: boolean;
	data: unknown;
};

type BetterAuthClientOptions = {
	fetchOptions?: {
		auth?: {
			type: 'Bearer';
			token: () => string | undefined;
		};
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
let capturedFetches: Array<{
	input: Request | string | URL;
	init: RequestInit | undefined;
}> = [];

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

const { createBearerAuth, createCookieAuth } = await import(
	'./create-auth.ts'
);

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
	capturedFetches = [];
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
} = {}): BearerSession {
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

function betterAuthSessionData(value: BearerSession) {
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

function identityFromSession(value: BearerSession): AuthIdentity {
	return {
		user: value.user,
		encryptionKeys: value.encryptionKeys,
	};
}

function createStorage({
	load,
	save = () => {},
}: {
	load: () => BearerSession | null | Promise<BearerSession | null>;
	save?: (value: BearerSession | null) => void | Promise<void>;
}) {
	const saved: Array<BearerSession | null> = [];
	const loaded = load();
	const initialSession = loaded instanceof Promise ? null : loaded;
	const storage = {
		load,
		save(value: BearerSession | null) {
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
	return createBearerAuth({
		baseURL: 'http://localhost:8787',
		initialSession: setup.initialSession,
		saveSession: setup.storage.save,
	});
}

function captureFetch() {
	globalThis.fetch = (async (
		input: Request | string | URL,
		init?: RequestInit,
	) => {
		capturedFetches.push({ input, init });
		return new Response(JSON.stringify(null), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	}) as unknown as typeof fetch;
}

function emitBetterSession(data: unknown) {
	currentBetterAuthState = { isPending: false, data };
	for (const listener of betterAuthSessionListeners) {
		listener(currentBetterAuthState);
	}
}

test('onChange does not replay and receives future changes only', async () => {
	const setup = createStorage({ load: () => null });
	const auth = createTestAuth(setup);

	const identities: Array<AuthIdentity | null> = [];
	auth.onChange((identity) => identities.push(identity));

	expect(identities).toEqual([]);

	emitBetterSession(betterAuthSessionData(session()));

	expect(identities).toEqual([identityFromSession(session())]);
	auth[Symbol.dispose]();
});

test('listener failures do not stop later listeners', async () => {
	const setup = createStorage({ load: () => null });
	const auth = createTestAuth(setup);
	const identities: Array<AuthIdentity | null> = [];

	auth.onChange(() => {
		throw new Error('listener failed');
	});
	auth.onChange((identity) => identities.push(identity));

	emitBetterSession(betterAuthSessionData(session({ token: 'token-2' })));

	expect(identities).toEqual([
		identityFromSession(session({ token: 'token-2' })),
	]);
	auth[Symbol.dispose]();
});

test('initial session drives initial signed-in identity', async () => {
	// Seed the BA atom so the late subscribe replays the matching session
	// instead of the default null (which would flip the identity to null).
	emitBetterSession(betterAuthSessionData(session()));
	const setup = createStorage({ load: () => session() });
	const auth = createTestAuth(setup);

	expect(auth.identity).toEqual(identityFromSession(session()));
	auth[Symbol.dispose]();
});

test('whenReady resolves after the first settled session event', async () => {
	currentBetterAuthState = { isPending: true, data: null };
	const setup = createStorage({ load: () => null });
	const auth = createTestAuth(setup);
	let ready = false;

	void auth.whenReady.then(() => {
		ready = true;
	});
	await Promise.resolve();
	expect(ready).toBe(false);

	emitBetterSession(null);
	await auth.whenReady;

	expect(ready).toBe(true);
	auth[Symbol.dispose]();
});

test('openWebSocket returns null signed out and adds bearer subprotocol signed in', async () => {
	const setup = createStorage({ load: () => null });
	const auth = createTestAuth(setup);

	expect(auth.openWebSocket('ws://localhost/sync')).toBeNull();

	emitBetterSession(betterAuthSessionData(session({ token: 'token-2' })));
	const ws = auth.openWebSocket('ws://localhost/sync');

	expect(ws).toBe(capturedWebSockets[0] as unknown as WebSocket);
	expect(capturedWebSockets[0]).toMatchObject({
		url: 'ws://localhost/sync',
		protocols: ['epicenter', 'bearer.token-2'],
	});
	auth[Symbol.dispose]();
});

test('bearer fetch sends Authorization and omits cookies', async () => {
	captureFetch();
	emitBetterSession(betterAuthSessionData(session()));
	const setup = createStorage({ load: () => session() });
	const auth = createTestAuth(setup);

	await auth.fetch('http://localhost/api');

	const init = capturedFetches[0]?.init;
	expect(init?.credentials).toBe('omit');
	expect(new Headers(init?.headers).get('Authorization')).toBe(
		'Bearer token-1',
	);
	auth[Symbol.dispose]();
});

test('cookie fetch uses cookies and strips Authorization', async () => {
	captureFetch();
	currentBetterAuthState = { isPending: true, data: null };
	const saved: Array<AuthIdentity | null> = [];
	const auth = createCookieAuth({
		baseURL: 'http://localhost:8787',
		initialIdentity: identityFromSession(session()),
		saveIdentity: (next) => {
			saved.push(next);
		},
	});

	await auth.fetch('http://localhost/api', {
		headers: { Authorization: 'Bearer should-not-send' },
		credentials: 'omit',
	});

	const init = capturedFetches[0]?.init;
	expect(init?.credentials).toBe('include');
	expect(new Headers(init?.headers).has('Authorization')).toBe(false);
	expect(saved).toEqual([]);
	auth[Symbol.dispose]();
});

test('cookie openWebSocket returns plain protocols when identity exists', async () => {
	currentBetterAuthState = { isPending: true, data: null };
	const auth = createCookieAuth({
		baseURL: 'http://localhost:8787',
		initialIdentity: identityFromSession(session()),
	});

	const ws = auth.openWebSocket('ws://localhost/sync', ['epicenter']);

	expect(ws).toBe(capturedWebSockets[0] as unknown as WebSocket);
	expect(capturedWebSockets[0]).toMatchObject({
		url: 'ws://localhost/sync',
		protocols: ['epicenter'],
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

test('Better Auth signed-in emission drives identity and storage save', async () => {
	const setup = createStorage({ load: () => null });
	const auth = createTestAuth(setup);

	emitBetterSession(betterAuthSessionData(session()));

	expect(auth.identity).toEqual(identityFromSession(session()));
	expect(setup.saved).toEqual([session()]);
	auth[Symbol.dispose]();
});

test('Better Auth signed-out emission drives identity and storage save', async () => {
	// Seed the BA atom with the matching session so the late subscribe is
	// a no-op (sessionsEqual short-circuits); the explicit null emission
	// below is the only event that drives the signedIn -> signedOut switch.
	emitBetterSession(betterAuthSessionData(session()));
	const setup = createStorage({ load: () => session() });
	const auth = createTestAuth(setup);

	emitBetterSession(null);

	expect(auth.identity).toBeNull();
	expect(setup.saved).toEqual([null]);
	auth[Symbol.dispose]();
});

test('subscribe replay matching the initial session does not write storage', async () => {
	emitBetterSession(betterAuthSessionData(session()));
	const setup = createStorage({ load: () => session() });
	const auth = createTestAuth(setup);

	expect(setup.saved).toEqual([]);
	auth[Symbol.dispose]();
});

test('response-header token rotation persists through session storage save', async () => {
	// Seed the BA atom so the late subscribe is a no-op; without this, the
	// default null replay would flip the identity to null and the rotation
	// hook below would not fire.
	emitBetterSession(betterAuthSessionData(session({ token: 'old-token' })));
	const setup = createStorage({ load: () => session({ token: 'old-token' }) });
	const auth = createTestAuth(setup);

	signInResponseHeaders = { 'set-auth-token': 'new-token' };
	await auth.signIn({ email: 'user@example.com', password: 'password' });

	const expected = session({ token: 'new-token' });
	expect(auth.identity).toEqual(identityFromSession(expected));
	expect(setup.saved).toEqual([expected]);
	expect(betterAuthClientOptions).not.toBeNull();
	auth[Symbol.dispose]();
});

test('response-header token rotation does not emit an identity change', async () => {
	emitBetterSession(betterAuthSessionData(session({ token: 'old-token' })));
	const setup = createStorage({ load: () => session({ token: 'old-token' }) });
	const auth = createTestAuth(setup);
	const identities: Array<AuthIdentity | null> = [];
	auth.onChange((identity) => identities.push(identity));

	signInResponseHeaders = { 'set-auth-token': 'new-token' };
	await auth.signIn({ email: 'user@example.com', password: 'password' });

	expect(identities).toEqual([]);
	auth[Symbol.dispose]();
});
