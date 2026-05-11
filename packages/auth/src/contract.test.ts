/**
 * Auth Client Contract Tests
 *
 * Verifies the OAuth-only public auth client surface.
 *
 * Key behaviors:
 * - AuthClient exposes hosted sign-in, sign-out, fetch, and WebSocket transport
 * - Credential form methods and raw token getters are absent from the type
 */

import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import type { AuthClient, OAuthSessionStorage } from './index.js';
import { createOAuthAppAuth } from './index.js';

test('OAuth app auth satisfies the AuthClient contract', async () => {
	const sessionStorage: OAuthSessionStorage = {
		get: () => null,
		set: () => {},
	};
	const auth: AuthClient = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		sessionStorage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: (async () =>
			new Response(null, { status: 204 })) as unknown as typeof fetch,
		WebSocket: class {
			constructor() {}
		} as unknown as typeof WebSocket,
	});

	expect(await auth.startSignIn()).toEqual(Ok(undefined));
	expect(await auth.fetch('http://localhost:8787/resource')).toHaveProperty(
		'status',
		204,
	);
	expect(await auth.openWebSocket('ws://localhost:8787/sync')).toBeDefined();
	expect(await auth.signOut()).toEqual(Ok(undefined));
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('legacy credential and token members are not part of AuthClient', () => {
	const sessionStorage: OAuthSessionStorage = {
		get: () => null,
		set: () => {},
	};
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		sessionStorage,
		launcher: { startSignIn: async () => Ok(null) },
	});

	// @ts-expect-error: raw token access was removed from AuthClient
	expect(auth.bearerToken).toBeUndefined();
	// @ts-expect-error: credential form sign-in was removed from AuthClient
	expect(auth.signIn).toBeUndefined();
	// @ts-expect-error: credential form sign-up was removed from AuthClient
	expect(auth.signUp).toBeUndefined();
	// @ts-expect-error: provider-specific sign-in was replaced by startSignIn
	expect(auth.signInWithSocial).toBeUndefined();
});
