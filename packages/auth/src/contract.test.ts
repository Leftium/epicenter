/**
 * Auth Client Contract Tests
 *
 * Covers:
 * - PersistedAuth = { grant, unlock } shape
 * - AuthState three variants; `email` is the implicit freshness predicate
 * - Refresh writes only grant, unlock byte-identical
 * - Same-user guard at /api/me response
 * - Network gate: bearer not attached until /api/me confirms same user
 * - Cold-boot offline keeps signed-in with unlock + email=null
 */

import { describe, expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import type {
	AuthClient,
	LocalUnlockBundle,
	OAuthTokenGrant,
	PersistedAuth,
	PersistedAuthStorage,
} from './index.js';
import { createOAuthAppAuth } from './index.js';

const now = 1_000_000;

const encryptionKeys = [
	{
		version: 1,
		userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
] satisfies LocalUnlockBundle['encryptionKeys'];

function grant({
	accessToken = 'access-token',
	refreshToken = 'refresh-token',
	accessTokenExpiresAt = now + 3_600_000,
}: Partial<OAuthTokenGrant> = {}): OAuthTokenGrant {
	return { accessToken, refreshToken, accessTokenExpiresAt };
}

function cell({
	userId = 'user-1',
	grant: g = grant(),
}: { userId?: string; grant?: OAuthTokenGrant } = {}): PersistedAuth {
	return {
		grant: g,
		unlock: { userId, encryptionKeys: [...encryptionKeys] },
	};
}

function createStorage(initial: PersistedAuth | null = null) {
	let current = initial;
	const saved: Array<PersistedAuth | null> = [];
	const storage: PersistedAuthStorage = {
		get: () => current,
		set: async (next) => {
			current = next;
			saved.push(next);
		},
	};
	return {
		storage,
		saved,
		get current() {
			return current;
		},
	};
}

function json(value: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(value), {
		status: 200,
		...init,
		headers: { 'content-type': 'application/json', ...init?.headers },
	});
}

function apiMeBody(userId = 'user-1') {
	return {
		user: { id: userId, email: `${userId}@example.com` },
		encryptionKeys: [...encryptionKeys],
	};
}

test('signed-out by default; AuthClient satisfies the public contract', () => {
	const setup = createStorage(null);
	const auth: AuthClient = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
	});

	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('cold-boot signed-in exposes unlock immediately with email=null', () => {
	const setup = createStorage(cell());
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
	});

	expect(auth.state).toEqual({
		status: 'signed-in',
		unlock: { userId: 'user-1', encryptionKeys: [...encryptionKeys] },
		email: null,
	});
	auth[Symbol.dispose]();
});

test('startSignIn calls /api/me and writes both sections', async () => {
	const setup = createStorage(null);
	const fetches: string[] = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: {
			startSignIn: async () =>
				Ok({
					accessToken: 'sign-in-access',
					refreshToken: 'sign-in-refresh',
					accessTokenExpiresAt: now + 3_600_000,
				}),
		},
		fetch: (async (input: Request | string | URL) => {
			fetches.push(String(input));
			return json(apiMeBody('user-1'));
		}) as unknown as typeof fetch,
	});

	const result = await auth.startSignIn();
	expect(result).toEqual(Ok(undefined));
	expect(fetches[0]).toBe('http://localhost:8787/api/me');
	expect(setup.saved[0]).toEqual({
		grant: {
			accessToken: 'sign-in-access',
			refreshToken: 'sign-in-refresh',
			accessTokenExpiresAt: now + 3_600_000,
		},
		unlock: { userId: 'user-1', encryptionKeys: [...encryptionKeys] },
	});
	expect(auth.state).toMatchObject({
		status: 'signed-in',
		email: 'user-1@example.com',
	});
	auth[Symbol.dispose]();
});

test('refresh writes ONLY the grant section; unlock byte-identical', async () => {
	const initial = cell({ grant: grant({ accessTokenExpiresAt: now + 1 }) });
	const setup = createStorage(initial);
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		refreshOAuthToken: async () => ({
			accessToken: 'new-access',
			refreshToken: 'new-refresh',
			accessTokenExpiresAt: now + 3_600_000,
		}),
		fetch: (async (input: Request | string | URL) => {
			if (String(input).endsWith('/api/me')) return json(apiMeBody('user-1'));
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch,
	});

	await auth.fetch('http://localhost:8787/resource');
	const last = setup.saved.at(-1);
	expect(last?.unlock).toEqual(initial.unlock);
	expect(last?.grant).toEqual({
		accessToken: 'new-access',
		refreshToken: 'new-refresh',
		accessTokenExpiresAt: now + 3_600_000,
	});
	auth[Symbol.dispose]();
});

test('same-user guard wipes the cell when /api/me returns a different userId', async () => {
	const setup = createStorage(cell({ userId: 'alice' }));
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: (async (input: Request | string | URL) => {
			if (String(input).endsWith('/api/me')) return json(apiMeBody('bob'));
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch,
	});

	const response = await auth.fetch('http://localhost:8787/resource');
	expect(response.status).toBe(204);
	expect(setup.current).toBeNull();
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('network gate: no Authorization header until /api/me confirms same user', async () => {
	const setup = createStorage(cell());
	const seenAuth: Array<string | null> = [];
	let resolveApiMe!: (response: Response) => void;
	const apiMePromise = new Promise<Response>((r) => {
		resolveApiMe = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: (async (input: Request | string | URL, init?: RequestInit) => {
			if (String(input).endsWith('/api/me')) return apiMePromise;
			seenAuth.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch,
	});

	const fetchPromise = auth.fetch('http://localhost:8787/resource');
	await Promise.resolve();
	expect(seenAuth).toEqual([]);
	resolveApiMe(json(apiMeBody('user-1')));
	await fetchPromise;
	expect(seenAuth).toEqual(['Bearer access-token']);
	auth[Symbol.dispose]();
});

test('cold-boot offline keeps signed-in with unlock and email=null', async () => {
	const setup = createStorage(cell());
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: (async () => {
			throw new Error('offline');
		}) as unknown as typeof fetch,
	});

	expect(auth.state).toMatchObject({
		status: 'signed-in',
		email: null,
	});
	expect((auth.state as { unlock: LocalUnlockBundle }).unlock).toEqual({
		userId: 'user-1',
		encryptionKeys: [...encryptionKeys],
	});
	auth[Symbol.dispose]();
});

describe('removed legacy surface', () => {
	test('requireIdentity / requireSession / OAuthSession are not exported', async () => {
		const mod = await import('./index.js');
		// @ts-expect-error: requireIdentity removed; reach for state.unlock.
		expect(mod.requireIdentity).toBeUndefined();
		// @ts-expect-error: requireSession removed.
		expect(mod.requireSession).toBeUndefined();
		// @ts-expect-error: OAuthSession deleted; use PersistedAuth.
		expect(mod.OAuthSession).toBeUndefined();
	});
});
