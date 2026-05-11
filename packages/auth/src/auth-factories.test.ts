/**
 * OAuth App Auth Factory Tests
 *
 * Verifies the OAuth-only app auth core through public client behavior.
 *
 * Key behaviors:
 * - Hosted sign-in loads identity through `/auth/me` and persists OAuthSession
 * - Cached sessions boot into local identity without network
 * - Refresh is persisted before protected fetches and WebSockets use new tokens
 * - 401 responses retry once after refresh
 * - Refresh failure preserves identity and pauses network auth
 * - Sign-out clears local OAuth session storage
 */

import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import type { AuthIdentity, AuthState, OAuthSession } from './index.js';
import { createOAuthAppAuth } from './index.js';

const now = 1_000_000;

function identity({
	userId = 'user-1',
}: {
	userId?: string;
} = {}): AuthIdentity {
	return {
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

function session({
	accessToken = 'access-token',
	refreshToken = 'refresh-token',
	accessTokenExpiresAt = now + 3_600_000,
	userId = 'user-1',
}: {
	accessToken?: string;
	refreshToken?: string;
	accessTokenExpiresAt?: number;
	userId?: string;
} = {}): OAuthSession {
	return {
		...identity({ userId }),
		accessToken,
		refreshToken,
		accessTokenExpiresAt,
	};
}

function signedInState(value = session()): AuthState {
	return {
		status: 'signed-in',
		identity: identityFromSession(value),
	};
}

function identityFromSession(value: OAuthSession): AuthIdentity {
	return {
		user: value.user,
		encryptionKeys: value.encryptionKeys,
	};
}

function createStorage(initial: OAuthSession | null) {
	let current = initial;
	const saved: Array<OAuthSession | null> = [];
	return {
		saved,
		sessionStorage: {
			get: () => current,
			set: async (next: OAuthSession | null) => {
				current = next;
				saved.push(next);
			},
		},
	};
}

function json(value: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(value), {
		status: 200,
		...init,
		headers: {
			'content-type': 'application/json',
			...init?.headers,
		},
	});
}

test('startSignIn loads identity through auth/me and stores OAuthSession', async () => {
	const setup = createStorage(null);
	const fetches: Array<{ input: Request | string | URL; init?: RequestInit }> =
		[];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		sessionStorage: setup.sessionStorage,
		launcher: {
			startSignIn: async (input) => {
				expect(input).toEqual({ returnTo: '/workspaces/1' });
				return Ok({
					accessToken: 'oauth-access-token',
					refreshToken: 'oauth-refresh-token',
					accessTokenExpiresAt: now + 3_600_000,
					scope: null,
					tokenType: 'bearer',
				});
			},
		},
		fetch: (async (input: Request | string | URL, init?: RequestInit) => {
			fetches.push({ input, init });
			return json(identity());
		}) as unknown as typeof fetch,
	});

	const result = await auth.startSignIn({ returnTo: '/workspaces/1' });

	expect(result).toEqual(Ok(undefined));
	expect(String(fetches[0]?.input)).toBe('http://localhost:8787/auth/me');
	expect(new Headers(fetches[0]?.init?.headers).get('authorization')).toBe(
		'Bearer oauth-access-token',
	);
	expect(fetches[0]?.init?.credentials).toBe('omit');
	expect(auth.state).toEqual(
		signedInState(
			session({
				accessToken: 'oauth-access-token',
				refreshToken: 'oauth-refresh-token',
			}),
		),
	);
	expect(setup.saved).toEqual([
		session({
			accessToken: 'oauth-access-token',
			refreshToken: 'oauth-refresh-token',
		}),
	]);
});

test('startSignIn completion without tokens is not treated as signed in', async () => {
	const setup = createStorage(null);
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		sessionStorage: setup.sessionStorage,
		launcher: {
			startSignIn: async () => Ok(null),
		},
	});

	const result = await auth.startSignIn();

	expect(result).toEqual(Ok(undefined));
	expect(auth.state).toEqual({ status: 'signed-out' });
	expect(setup.saved).toEqual([]);
});

test('cached OAuthSession boots into signed-in or reauth-required identity without network', () => {
	let fetchCalls = 0;
	const signedInAuth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		sessionStorage: createStorage(session()).sessionStorage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: (async () => {
			fetchCalls += 1;
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch,
	});
	const reauthAuth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		sessionStorage: createStorage(session({ accessTokenExpiresAt: now - 1 }))
			.sessionStorage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: (async () => {
			fetchCalls += 1;
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch,
	});

	expect(signedInAuth.state).toEqual(signedInState());
	expect(reauthAuth.state).toEqual({
		status: 'reauth-required',
		identity: identityFromSession(session({ accessTokenExpiresAt: now - 1 })),
	});
	expect(fetchCalls).toBe(0);
});

test('fetch awaits refreshed session storage before sending the request', async () => {
	const setup = createStorage(session({ accessTokenExpiresAt: now + 1 }));
	const fetches: Array<{ input: Request | string | URL; init?: RequestInit }> =
		[];
	let releaseStorage: () => void = () => {};
	setup.sessionStorage.set = (next: OAuthSession | null) => {
		setup.saved.push(next);
		return new Promise<void>((resolve) => {
			releaseStorage = resolve;
		});
	};
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		sessionStorage: setup.sessionStorage,
		launcher: { startSignIn: async () => Ok(null) },
		refreshOAuthToken: async ({ session: current }) => {
			expect(current.refreshToken).toBe('refresh-token');
			return {
				accessToken: 'new-access-token',
				refreshToken: 'new-refresh-token',
				accessTokenExpiresAt: now + 3_600_000,
				scope: null,
				tokenType: 'bearer',
			};
		},
		fetch: (async (input, init) => {
			fetches.push({ input, init });
			return new Response(null, { status: 204 });
		}) as typeof fetch,
	});

	const responsePromise = auth.fetch('http://localhost:8787/resource');
	await Promise.resolve();
	await Promise.resolve();

	expect(fetches).toEqual([]);
	releaseStorage();
	const response = await responsePromise;

	expect(response.status).toBe(204);
	expect(new Headers(fetches[0]?.init?.headers).get('authorization')).toBe(
		'Bearer new-access-token',
	);
	expect(setup.saved[0]?.accessToken).toBe('new-access-token');
});

test('fetch retries once after a 401 with a refreshed access token', async () => {
	const setup = createStorage(session());
	const authorizations: Array<string | null> = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		sessionStorage: setup.sessionStorage,
		launcher: { startSignIn: async () => Ok(null) },
		refreshOAuthToken: async () => ({
			accessToken: 'retry-access-token',
			refreshToken: 'retry-refresh-token',
			accessTokenExpiresAt: now + 3_600_000,
			scope: null,
			tokenType: 'bearer',
		}),
		fetch: (async (_input, init) => {
			authorizations.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, {
				status: authorizations.length === 1 ? 401 : 204,
			});
		}) as typeof fetch,
	});

	const response = await auth.fetch('http://localhost:8787/resource');

	expect(response.status).toBe(204);
	expect(authorizations).toEqual([
		'Bearer access-token',
		'Bearer retry-access-token',
	]);
	expect(setup.saved[0]?.accessToken).toBe('retry-access-token');
});

test('refresh failure preserves identity and pauses network auth', async () => {
	const setup = createStorage(session({ accessTokenExpiresAt: now + 1 }));
	const authorizations: Array<string | null> = [];
	const originalConsoleError = console.error;
	console.error = () => {};
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		sessionStorage: setup.sessionStorage,
		launcher: { startSignIn: async () => Ok(null) },
		refreshOAuthToken: async () => {
			throw new Error('refresh failed');
		},
		fetch: (async (_input, init) => {
			authorizations.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, { status: 401 });
		}) as typeof fetch,
	});

	try {
		await auth.fetch('http://localhost:8787/resource');
	} finally {
		console.error = originalConsoleError;
	}

	expect(auth.state).toEqual({
		status: 'reauth-required',
		identity: identityFromSession(session({ accessTokenExpiresAt: now + 1 })),
	});
	expect(setup.saved).toEqual([]);
	expect(authorizations).toEqual([null]);
});

test('signOut clears OAuthSession storage', async () => {
	const setup = createStorage(session());
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		sessionStorage: setup.sessionStorage,
		launcher: { startSignIn: async () => Ok(null) },
	});

	const result = await auth.signOut();

	expect(result).toEqual(Ok(undefined));
	expect(auth.state).toEqual({ status: 'signed-out' });
	expect(setup.saved).toEqual([null]);
});

test('openWebSocket refreshes first and appends the bearer subprotocol', async () => {
	const setup = createStorage(session({ accessTokenExpiresAt: now + 1 }));
	const sockets: Array<{ url: string; protocols?: string[] }> = [];
	const WebSocketImpl = class {
		constructor(url: string, protocols?: string[]) {
			sockets.push({ url, protocols });
		}
	} as unknown as typeof WebSocket;
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		sessionStorage: setup.sessionStorage,
		launcher: { startSignIn: async () => Ok(null) },
		WebSocket: WebSocketImpl,
		refreshOAuthToken: async () => ({
			accessToken: 'socket-access-token',
			refreshToken: 'socket-refresh-token',
			accessTokenExpiresAt: now + 3_600_000,
			scope: null,
			tokenType: 'bearer',
		}),
	});

	await auth.openWebSocket('ws://localhost:8787/sync', ['epicenter']);

	expect(sockets).toEqual([
		{
			url: 'ws://localhost:8787/sync',
			protocols: ['epicenter', 'bearer.socket-access-token'],
		},
	]);
	expect(setup.saved[0]?.accessToken).toBe('socket-access-token');
});
