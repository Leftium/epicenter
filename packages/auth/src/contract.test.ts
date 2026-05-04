/**
 * Auth Client Contract Tests
 *
 * Verifies that `createCookieAuth` and `createBearerAuth` expose the same
 * public `AuthClient` behavior while keeping transport differences internal.
 *
 * Key behaviors:
 * - Both factories expose and exercise every public AuthClient member
 * - Better Auth command methods receive the expected input shapes
 * - Fetch and WebSocket credentials stay transport-specific below the client
 */

import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import type { AuthClient, AuthIdentity, BearerSession } from './index.ts';

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

let listeners = new Set<(state: BetterAuthSessionState) => void>();
let currentState: BetterAuthSessionState = { isPending: false, data: null };
let betterAuthOptions: BetterAuthClientOptions | null = null;
let calls: Array<{ method: string; input?: unknown }> = [];
let fetches: Array<{ input: Request | string | URL; init?: RequestInit }> = [];
let sockets: FakeWebSocket[] = [];

mock.module('better-auth/client', () => ({
	createAuthClient(options: BetterAuthClientOptions) {
		betterAuthOptions = options;
		return {
			useSession: {
				subscribe(listener: (state: BetterAuthSessionState) => void) {
					listener(currentState);
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
			signIn: {
				email: async (input: unknown) => {
					calls.push({ method: 'signIn.email', input });
					options.fetchOptions?.onSuccess?.({
						response: new Response(null, {
							headers: { 'set-auth-token': 'token-2' },
						}),
					});
					return { error: null };
				},
				social: async (input: unknown) => {
					calls.push({ method: 'signIn.social', input });
					return { error: null };
				},
			},
			signUp: {
				email: async (input: unknown) => {
					calls.push({ method: 'signUp.email', input });
					return { error: null };
				},
			},
			signOut: async () => {
				calls.push({ method: 'signOut' });
				return { error: null };
			},
		};
	},
	InferPlugin: () => ({}),
}));

const { createBearerAuth, createCookieAuth } = await import('./index.ts');

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalConsoleError = console.error;

class FakeWebSocket {
	constructor(
		readonly url: string | URL,
		readonly protocols?: string | string[],
	) {
		sockets.push(this);
	}

	close() {}
}

beforeEach(() => {
	listeners = new Set();
	currentState = { isPending: false, data: betterAuthSessionData(session()) };
	betterAuthOptions = null;
	calls = [];
	fetches = [];
	sockets = [];
	globalThis.fetch = (async (
		input: Request | string | URL,
		init?: RequestInit,
	) => {
		fetches.push({ input, init });
		return new Response(null, { status: 204 });
	}) as unknown as typeof fetch;
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	console.error = () => {};
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

function identityFromSession(value: BearerSession): AuthIdentity {
	return {
		user: value.user,
		encryptionKeys: value.encryptionKeys,
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

function emitSession(value: BearerSession | null) {
	currentState = {
		isPending: false,
		data: value === null ? null : betterAuthSessionData(value),
	};
	for (const listener of listeners) listener(currentState);
}

type ContractCase = {
	name: string;
	create(): AuthClient;
	expectTransport(): void;
};

const contractCases: ContractCase[] = [
	{
		name: 'cookie',
		create() {
			return createCookieAuth({
				baseURL: 'http://localhost:8787',
				initialIdentity: identityFromSession(session()),
			});
		},
		expectTransport() {
			expect(new Headers(fetches[0]?.init?.headers).has('Authorization')).toBe(
				false,
			);
			expect(fetches[0]?.init?.credentials).toBe('include');
			expect(sockets[0]).toMatchObject({
				url: 'ws://localhost/sync',
				protocols: ['epicenter'],
			});
			expect(betterAuthOptions?.fetchOptions?.auth).toBeUndefined();
		},
	},
	{
		name: 'bearer',
		create() {
			return createBearerAuth({
				baseURL: 'http://localhost:8787',
				initialSession: session(),
				saveSession: () => {},
			});
		},
		expectTransport() {
			expect(new Headers(fetches[0]?.init?.headers).get('Authorization')).toBe(
				'Bearer token-2',
			);
			expect(fetches[0]?.init?.credentials).toBe('omit');
			expect(sockets[0]).toMatchObject({
				url: 'ws://localhost/sync',
				protocols: ['epicenter', 'bearer.token-2'],
			});
			expect(betterAuthOptions?.fetchOptions?.auth?.type).toBe('Bearer');
		},
	},
];

for (const contractCase of contractCases) {
	test(`${contractCase.name} factory satisfies the AuthClient contract`, async () => {
		const auth = contractCase.create();
		const identities: Array<AuthIdentity | null> = [];
		const unsubscribe = auth.onChange((identity) => identities.push(identity));

		expect(auth.identity).toEqual(identityFromSession(session()));
		await auth.whenReady;

		emitSession(session({ userId: 'user-2', token: 'token-2' }));

		expect(identities).toEqual([
			identityFromSession(session({ userId: 'user-2', token: 'token-2' })),
		]);
		expect(
			await auth.signIn({ email: 'user@example.com', password: 'pw' }),
		).toEqual(Ok(undefined));
		expect(
			await auth.signUp({
				email: 'user@example.com',
				password: 'pw',
				name: 'User',
			}),
		).toEqual(Ok(undefined));
		expect(
			await auth.signInWithIdToken({
				provider: 'google',
				idToken: 'id-token',
				nonce: 'nonce',
			}),
		).toEqual(Ok(undefined));
		expect(
			await auth.signInWithSocialRedirect({
				provider: 'google',
				callbackURL: 'http://localhost/callback',
			}),
		).toEqual(Ok(undefined));

		await auth.fetch('http://localhost/api', {
			headers: { Authorization: 'Bearer caller-token' },
		});
		expect(auth.openWebSocket('ws://localhost/sync', ['epicenter'])).toBe(
			sockets[0] as unknown as WebSocket,
		);

		contractCase.expectTransport();
		expect(calls).toEqual([
			{
				method: 'signIn.email',
				input: { email: 'user@example.com', password: 'pw' },
			},
			{
				method: 'signUp.email',
				input: { email: 'user@example.com', password: 'pw', name: 'User' },
			},
			{
				method: 'signIn.social',
				input: {
					provider: 'google',
					idToken: { token: 'id-token', nonce: 'nonce' },
				},
			},
			{
				method: 'signIn.social',
				input: {
					provider: 'google',
					callbackURL: 'http://localhost/callback',
				},
			},
		]);

		expect(await auth.signOut()).toEqual(Ok(undefined));
		expect(auth.identity).toBeNull();
		expect(calls.at(-1)).toEqual({ method: 'signOut' });

		unsubscribe();
		auth[Symbol.dispose]();
		expect(listeners.size).toBe(0);
	});
}
