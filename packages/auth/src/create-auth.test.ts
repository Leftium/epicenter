/**
 * Core Auth State API Tests
 *
 * Verifies the public state listener and settled-state helper exposed by
 * the framework-agnostic auth client.
 *
 * Key behaviors:
 * - Caller-provided session storage seeds the first identity
 * - Local updates are passed to the caller-provided storage adapter
 * - Better Auth session emissions drive live signed-in and signed-out state
 */

import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type {
	AuthIdentity,
	AuthState,
	BearerSession,
	BearerSessionStorage,
	CreateBearerAuthConfig,
} from './index.ts';

type BetterAuthSessionState = {
	isPending: boolean;
	data: unknown;
};

type BetterAuthClientOptions = {
	baseURL?: string;
	basePath?: string;
	fetchOptions?: {
		auth?: {
			type: 'Bearer';
			token: () => string | undefined;
		};
		onSuccess?: (context: { response: Response }) => void;
		customFetchImpl?: typeof fetch;
	};
};
type PerCallFetchOptions = {
	headers?: RequestInit['headers'];
	onSuccess?: (context: { response: Response }) => void;
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
			signOut: (input?: { fetchOptions?: PerCallFetchOptions }) =>
				callCustomFetch(options, '/sign-out', {
					method: 'POST',
					body: {},
					fetchOptions: input?.fetchOptions,
				}),
			deviceCode: (body: unknown) =>
				callCustomFetch(options, '/device/code', { method: 'POST', body }),
			deviceToken: (body: unknown) =>
				callCustomFetch(options, '/device/token', { method: 'POST', body }),
			getSession: (input?: { fetchOptions?: PerCallFetchOptions }) =>
				callCustomFetch(options, '/get-session', {
					method: 'GET',
					fetchOptions: input?.fetchOptions,
				}),
		};
	},
	InferPlugin: () => ({}),
}));

const { createBearerAuth, createCookieAuth, waitForAuthSettled } = await import(
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
	currentBetterAuthState = { isPending: false, data: null };
	betterAuthClientOptions = null;
	signInResponseHeaders = undefined;
	capturedFetches = [];
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	console.error = originalConsoleError;
	mock.restore();
});

async function callCustomFetch(
	options: BetterAuthClientOptions,
	path: string,
	{
		method,
		body,
		fetchOptions,
	}: {
		method: string;
		body?: unknown;
		fetchOptions?: PerCallFetchOptions;
	},
) {
	const fetchImpl = options.fetchOptions?.customFetchImpl;
	if (!fetchImpl) return { data: null, error: null };

	const headers = new Headers(fetchOptions?.headers);
	let requestBody: string | undefined;
	if (body !== undefined) {
		headers.set('content-type', 'application/json');
		requestBody = JSON.stringify(body);
	}

	const response = await fetchImpl(
		new URL(`${options.baseURL ?? ''}${options.basePath ?? ''}${path}`),
		{ method, headers, body: requestBody },
	);
	if (response.ok) fetchOptions?.onSuccess?.({ response });

	const text = await response.text();
	let parsed: unknown = {};
	try {
		parsed = text ? JSON.parse(text) : {};
	} catch {
		parsed = { error: text };
	}
	if (response.ok) return { data: parsed, error: null };
	return { data: null, error: parsed };
}

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

function signedInState(value: BearerSession): AuthState {
	return { status: 'signed-in', identity: identityFromSession(value) };
}

function createStorage({
	get,
	set = () => {},
}: {
	get: () => BearerSession | null;
	set?: (value: BearerSession | null) => void | Promise<void>;
}) {
	const saved: Array<BearerSession | null> = [];
	const sessionStorage: BearerSessionStorage = {
		get,
		set(value) {
			saved.push(value);
			return set(value);
		},
	};

	return {
		sessionStorage,
		saved,
	};
}

function createTestAuth(setup: ReturnType<typeof createStorage>) {
	return createBearerAuth({
		baseURL: 'http://localhost:8787',
		sessionStorage: setup.sessionStorage,
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

test('onStateChange does not replay and receives future changes only', async () => {
	const setup = createStorage({ get: () => null });
	const auth = createTestAuth(setup);

	const states: AuthState[] = [];
	auth.onStateChange((state) => states.push(state));

	expect(states).toEqual([]);

	emitBetterSession(betterAuthSessionData(session()));

	expect(states).toEqual([signedInState(session())]);
	auth[Symbol.dispose]();
});

test('listener failures do not stop later listeners', async () => {
	const setup = createStorage({ get: () => null });
	const auth = createTestAuth(setup);
	const states: AuthState[] = [];

	auth.onStateChange(() => {
		throw new Error('listener failed');
	});
	auth.onStateChange((state) => states.push(state));

	emitBetterSession(betterAuthSessionData(session({ token: 'token-2' })));

	expect(states).toEqual([signedInState(session({ token: 'token-2' }))]);
	auth[Symbol.dispose]();
});

test('initial session drives initial signed-in identity', async () => {
	// Seed the BA atom so the late subscribe replays the matching session
	// instead of the default null (which would flip the identity to null).
	emitBetterSession(betterAuthSessionData(session()));
	const setup = createStorage({ get: () => session() });
	const auth = createTestAuth(setup);

	expect(auth.state).toEqual(signedInState(session()));
	auth[Symbol.dispose]();
});

test('waitForAuthSettled resolves after the first settled session event', async () => {
	currentBetterAuthState = { isPending: true, data: null };
	const setup = createStorage({ get: () => null });
	const auth = createTestAuth(setup);
	let ready = false;

	void waitForAuthSettled(auth).then(() => {
		ready = true;
	});
	await Promise.resolve();
	expect(ready).toBe(false);

	emitBetterSession(null);
	await waitForAuthSettled(auth);

	expect(ready).toBe(true);
	auth[Symbol.dispose]();
});

test('bearerToken returns null signed out and current token signed in', async () => {
	const setup = createStorage({ get: () => null });
	const auth = createTestAuth(setup);

	expect(auth.bearerToken).toBeNull();

	emitBetterSession(betterAuthSessionData(session({ token: 'token-2' })));

	expect(auth.bearerToken).toBe('token-2');
	auth[Symbol.dispose]();
});

test('bearer fetch sends Authorization and omits cookies', async () => {
	captureFetch();
	emitBetterSession(betterAuthSessionData(session()));
	const setup = createStorage({ get: () => session() });
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

test('cookie signed-out settlement without cached identity does not write storage', async () => {
	const saved: Array<AuthIdentity | null> = [];
	const auth = createCookieAuth({
		baseURL: 'http://localhost:8787',
		saveIdentity: (next) => {
			saved.push(next);
		},
	});

	expect(auth.state).toEqual({ status: 'signed-out' });
	expect(saved).toEqual([]);
	auth[Symbol.dispose]();
});

test('cookie bearerToken always returns null', async () => {
	currentBetterAuthState = { isPending: true, data: null };
	const signedOutAuth = createCookieAuth({
		baseURL: 'http://localhost:8787',
		initialIdentity: null,
	});
	expect(signedOutAuth.bearerToken).toBeNull();
	signedOutAuth[Symbol.dispose]();

	const auth = createCookieAuth({
		baseURL: 'http://localhost:8787',
		initialIdentity: identityFromSession(session()),
	});

	expect(auth.bearerToken).toBeNull();
	auth[Symbol.dispose]();
});

test('dispose is idempotent and unsubscribes from Better Auth once', async () => {
	const setup = createStorage({
		get: () => null,
	});
	const auth = createTestAuth(setup);
	expect(betterAuthSessionListeners.size).toBe(1);

	auth[Symbol.dispose]();
	auth[Symbol.dispose]();

	expect(betterAuthSessionListeners.size).toBe(0);
});

test('sessionStorage.get() is read once during construction', async () => {
	let reads = 0;
	const setup = createStorage({
		get: () => {
			reads += 1;
			return null;
		},
	});
	const auth = createTestAuth(setup);

	emitBetterSession(betterAuthSessionData(session()));
	await auth.fetch('http://localhost/api');

	expect(reads).toBe(1);
	auth[Symbol.dispose]();
});

test('Better Auth signed-in validation drives identity and storage set', async () => {
	const setup = createStorage({ get: () => null });
	const auth = createTestAuth(setup);

	emitBetterSession(betterAuthSessionData(session()));

	expect(auth.state).toEqual(signedInState(session()));
	expect(setup.saved).toEqual([session()]);
	auth[Symbol.dispose]();
});

test('Better Auth signed-out emission clears session storage', async () => {
	// Seed the BA atom with the matching session so the late subscribe is
	// a no-op (sessionsEqual short-circuits); the explicit null emission
	// below is the only event that drives the signedIn -> signedOut switch.
	emitBetterSession(betterAuthSessionData(session()));
	const setup = createStorage({ get: () => session() });
	const auth = createTestAuth(setup);

	emitBetterSession(null);

	expect(auth.state).toEqual({ status: 'signed-out' });
	expect(setup.saved).toEqual([null]);
	auth[Symbol.dispose]();
});

test('subscribe replay matching the initial session does not write storage', async () => {
	emitBetterSession(betterAuthSessionData(session()));
	const setup = createStorage({ get: () => session() });
	const auth = createTestAuth(setup);

	expect(setup.saved).toEqual([]);
	auth[Symbol.dispose]();
});

test('response-header token rotation persists through session storage save', async () => {
	// Seed the BA atom so the late subscribe is a no-op; without this, the
	// default null replay would flip the identity to null and the rotation
	// hook below would not fire.
	emitBetterSession(betterAuthSessionData(session({ token: 'old-token' })));
	const setup = createStorage({ get: () => session({ token: 'old-token' }) });
	const auth = createTestAuth(setup);

	signInResponseHeaders = { 'set-auth-token': 'new-token' };
	await auth.signIn({ email: 'user@example.com', password: 'password' });

	const expected = session({ token: 'new-token' });
	expect(auth.state).toEqual(signedInState(expected));
	expect(setup.saved).toEqual([expected]);
	expect(betterAuthClientOptions).not.toBeNull();
	auth[Symbol.dispose]();
});

test('response-header token rotation does not emit an identity change', async () => {
	emitBetterSession(betterAuthSessionData(session({ token: 'old-token' })));
	const setup = createStorage({ get: () => session({ token: 'old-token' }) });
	const auth = createTestAuth(setup);
	const states: AuthState[] = [];
	auth.onStateChange((state) => states.push(state));

	signInResponseHeaders = { 'set-auth-token': 'new-token' };
	await auth.signIn({ email: 'user@example.com', password: 'password' });

	expect(states).toEqual([]);
	auth[Symbol.dispose]();
});

test('bearerToken returns the rotated token after set-auth-token response', async () => {
	// Sync reads `auth.bearerToken` fresh on every reconnect attempt. If
	// rotation ever stops updating the closure the getter would return the
	// old token forever, and reconnects would carry stale credentials.
	emitBetterSession(betterAuthSessionData(session({ token: 'old-token' })));
	const setup = createStorage({ get: () => session({ token: 'old-token' }) });
	const auth = createTestAuth(setup);

	expect(auth.bearerToken).toBe('old-token');

	signInResponseHeaders = { 'set-auth-token': 'new-token' };
	await auth.signIn({ email: 'user@example.com', password: 'password' });

	expect(auth.bearerToken).toBe('new-token');
	auth[Symbol.dispose]();
});

test('signOut clears bearer session storage', async () => {
	emitBetterSession(betterAuthSessionData(session()));
	const setup = createStorage({ get: () => session() });
	const auth = createTestAuth(setup);

	await auth.signOut();

	expect(auth.state).toEqual({ status: 'signed-out' });
	expect(setup.saved).toEqual([null]);
	auth[Symbol.dispose]();
});

test('sessionStorage.set() rejection is caught and logged', async () => {
	const failure = new Error('storage failed');
	const errors: unknown[][] = [];
	console.error = (...args: unknown[]) => {
		errors.push(args);
	};
	const setup = createStorage({
		get: () => null,
		set: () => Promise.reject(failure),
	});
	const auth = createTestAuth(setup);

	emitBetterSession(betterAuthSessionData(session()));
	await Promise.resolve();
	await Promise.resolve();

	expect(errors).toEqual([['[auth] failed to save session:', failure]]);
	expect(auth.state).toEqual(signedInState(session()));
	auth[Symbol.dispose]();
});

test('createBearerAuth rejects legacy session config at compile time', () => {
	const sessionStorage: BearerSessionStorage = {
		get: () => null,
		set: () => {},
	};
	createBearerAuth({ baseURL: 'http://localhost:8787', sessionStorage });

	const legacyConfig = {
		baseURL: 'http://localhost:8787',
		// @ts-expect-error: legacy initialSession and saveSession are not accepted
		initialSession: null,
		saveSession: () => {},
	} satisfies CreateBearerAuthConfig;

	expect(legacyConfig).toBeDefined();
});
