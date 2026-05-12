/**
 * OAuth App Auth Factory Tests
 *
 * Verifies the OAuth-only app auth core through public client behavior.
 *
 * Key behaviors:
 * - Hosted sign-in loads identity through `/workspace-identity` and persists OAuthSession
 * - Cached sessions boot into local identity without network
 * - Refresh is persisted before protected fetches and WebSockets use new tokens
 * - 401 responses retry once after refresh
 * - Refresh failure preserves identity and pauses network auth
 * - Sign-out revokes the refresh token before clearing local storage
 */

import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import type { WorkspaceIdentity, AuthState, OAuthSession } from './index.js';
import { createOAuthAppAuth } from './index.js';

const now = 1_000_000;

function identity({
	userId = 'user-1',
}: {
	userId?: string;
} = {}): WorkspaceIdentity {
	return {
		user: {
			id: userId,
			email: `${userId}@example.com`,
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

function identityFromSession(value: OAuthSession): WorkspaceIdentity {
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
		get current() {
			return current;
		},
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
	expect(String(fetches[0]?.input)).toBe('http://localhost:8787/workspace-identity');
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

test('cached OAuthSession boots into signed-in identity without network when access token is expired', () => {
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
	const expiredAuth = createOAuthAppAuth({
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
	expect(expiredAuth.state).toEqual(
		signedInState(session({ accessTokenExpiresAt: now - 1 })),
	);
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

test('fetch enters reauth-required when refreshed retry is rejected', async () => {
	const setup = createStorage(session());
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
		}),
		fetch: (async () =>
			new Response(null, { status: 401 })) as unknown as typeof fetch,
	});

	const response = await auth.fetch('http://localhost:8787/resource');

	expect(response.status).toBe(401);
	expect(auth.state).toEqual({
		status: 'reauth-required',
		identity: identityFromSession(
			session({
				accessToken: 'retry-access-token',
				refreshToken: 'retry-refresh-token',
				accessTokenExpiresAt: now + 3_600_000,
			}),
		),
	});
	expect(setup.current?.accessToken).toBe('retry-access-token');
});

test('fetch retries Request inputs with body using a fresh clone', async () => {
	const setup = createStorage(session());
	const attempts: Array<{ authorization: string | null; body: string }> = [];
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
		}),
		fetch: (async (input, init) => {
			expect(input).toBeInstanceOf(Request);
			attempts.push({
				authorization: new Headers(init?.headers).get('authorization'),
				body: await (input as Request).text(),
			});
			return new Response(null, {
				status: attempts.length === 1 ? 401 : 204,
			});
		}) as typeof fetch,
	});

	const response = await auth.fetch(
		new Request('http://localhost:8787/resource', {
			method: 'POST',
			body: 'request-body',
			headers: { 'content-type': 'text/plain' },
		}),
	);

	expect(response.status).toBe(204);
	expect(attempts).toEqual([
		{
			authorization: 'Bearer access-token',
			body: 'request-body',
		},
		{
			authorization: 'Bearer retry-access-token',
			body: 'request-body',
		},
	]);
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
	expect(setup.current).toEqual(session({ accessTokenExpiresAt: now + 1 }));
	expect(authorizations).toEqual([null]);
});

test('same-user startSignIn repairs reauth-required state and resumes network auth', async () => {
	const setup = createStorage(session({ accessTokenExpiresAt: now + 1 }));
	const authorizations: Array<string | null> = [];
	const originalConsoleError = console.error;
	console.error = () => {};
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		sessionStorage: setup.sessionStorage,
		launcher: {
			startSignIn: async () =>
				Ok({
					accessToken: 'repair-access-token',
					refreshToken: 'repair-refresh-token',
					accessTokenExpiresAt: now + 3_600_000,
				}),
		},
		refreshOAuthToken: async () => {
			throw new Error('refresh failed');
		},
		fetch: (async (input, init) => {
			if (String(input) === 'http://localhost:8787/workspace-identity') {
				return json(identity());
			}
			authorizations.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, { status: 204 });
		}) as typeof fetch,
	});

	try {
		await auth.fetch('http://localhost:8787/resource');
	} finally {
		console.error = originalConsoleError;
	}

	expect(auth.state.status).toBe('reauth-required');
	expect(await auth.startSignIn()).toEqual(Ok(undefined));
	expect(auth.state).toEqual(
		signedInState(
			session({
				accessToken: 'repair-access-token',
				refreshToken: 'repair-refresh-token',
			}),
		),
	);

	await auth.fetch('http://localhost:8787/resource');

	expect(authorizations).toEqual([null, 'Bearer repair-access-token']);
});

test('signOut during an in-flight refresh leaves the session signed out', async () => {
	const setup = createStorage(session({ accessTokenExpiresAt: now + 1 }));
	let releaseRefresh: (value: {
		accessToken: string;
		refreshToken: string;
		accessTokenExpiresAt: number;
	}) => void = () => {};
	const authorizations: Array<string | null> = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		sessionStorage: setup.sessionStorage,
		launcher: { startSignIn: async () => Ok(null) },
		revokeOAuthRefreshToken: async () => {},
		refreshOAuthToken: async () =>
			new Promise((resolve) => {
				releaseRefresh = resolve;
			}),
		fetch: (async (_input, init) => {
			authorizations.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, { status: 204 });
		}) as typeof fetch,
	});

	const fetchPromise = auth.fetch('http://localhost:8787/resource');
	await Promise.resolve();
	const signOutPromise = auth.signOut();
	await Promise.resolve();

	releaseRefresh({
		accessToken: 'stale-access-token',
		refreshToken: 'stale-refresh-token',
		accessTokenExpiresAt: now + 3_600_000,
	});

	const [response, signOutResult] = await Promise.all([
		fetchPromise,
		signOutPromise,
	]);

	expect(response.status).toBe(204);
	expect(signOutResult).toEqual(Ok(undefined));
	expect(auth.state).toEqual({ status: 'signed-out' });
	expect(setup.current).toBeNull();
	expect(setup.saved).toEqual([null]);
	expect(authorizations).toEqual([null]);
});

test('signOut revokes the refresh token before clearing OAuthSession storage', async () => {
	const setup = createStorage(session());
	const revokeCalls: Array<{
		baseURL: string;
		clientId: string;
		refreshToken: string;
	}> = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		sessionStorage: setup.sessionStorage,
		launcher: { startSignIn: async () => Ok(null) },
		revokeOAuthRefreshToken: async ({ baseURL, clientId, refreshToken }) => {
			revokeCalls.push({ baseURL, clientId, refreshToken });
		},
	});

	const result = await auth.signOut();

	expect(result).toEqual(Ok(undefined));
	expect(revokeCalls).toEqual([
		{
			baseURL: 'http://localhost:8787',
			clientId: 'client-1',
			refreshToken: 'refresh-token',
		},
	]);
	expect(auth.state).toEqual({ status: 'signed-out' });
	expect(setup.saved).toEqual([null]);
});

test('signOut clears OAuthSession storage when refresh token revocation fails', async () => {
	const setup = createStorage(session());
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		sessionStorage: setup.sessionStorage,
		launcher: { startSignIn: async () => Ok(null) },
		revokeOAuthRefreshToken: async () => {
			throw new Error('revoke failed');
		},
	});

	const result = await auth.signOut();

	expect(result).toEqual(Ok(undefined));
	expect(auth.state).toEqual({ status: 'signed-out' });
	expect(setup.saved).toEqual([null]);
});

test('signOut calls OAuth revoke endpoint with the public client id', async () => {
	const setup = createStorage(session());
	const requests: Array<{ input: Request | string | URL; init?: RequestInit }> =
		[];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		sessionStorage: setup.sessionStorage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: (async (input, init) => {
			requests.push({ input, init });
			return new Response(null, { status: 200 });
		}) as typeof fetch,
	});

	await auth.signOut();

	const body = requests[0]?.init?.body;
	expect(String(requests[0]?.input)).toBe(
		'http://localhost:8787/auth/oauth2/revoke',
	);
	expect(requests[0]?.init?.method).toBe('POST');
	expect(requests[0]?.init?.credentials).toBe('omit');
	expect(new Headers(requests[0]?.init?.headers).get('content-type')).toBe(
		'application/x-www-form-urlencoded',
	);
	expect(body).toBeInstanceOf(URLSearchParams);
	expect((body as URLSearchParams).get('client_id')).toBe('client-1');
	expect((body as URLSearchParams).get('token')).toBe('refresh-token');
	expect((body as URLSearchParams).get('token_type_hint')).toBe(
		'refresh_token',
	);
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
