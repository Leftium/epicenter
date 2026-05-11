/**
 * Auth Client Contract Tests
 *
 * Verifies that `createCookieAuth` and `createBearerAuth` expose the same
 * public `AuthClient` behavior while keeping transport differences internal.
 *
 * Key behaviors:
 * - Both factories expose and exercise every public AuthClient member
 * - Better Auth command methods receive the expected input shapes
 * - HTTP credentials stay auth-specific; sync credentials stay token-only
 */

import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import type {
	AuthClient,
	AuthIdentity,
	AuthState,
	BearerSession,
	BearerSessionStorage,
	OAuthSocialSignInAdapter,
} from './index.js';

type BetterAuthSessionState = {
	isPending: boolean;
	data: unknown;
};

type BetterAuthClientOptions = {
	baseURL?: string;
	basePath?: string;
	fetchOptions?: {
		credentials?: 'include' | 'omit' | 'same-origin';
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

let listeners = new Set<(state: BetterAuthSessionState) => void>();
let currentState: BetterAuthSessionState = { isPending: false, data: null };
let betterAuthOptions: BetterAuthClientOptions | null = null;
let calls: Array<{ method: string; input?: unknown }> = [];
let fetches: Array<{ input: Request | string | URL; init?: RequestInit }> = [];

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
			signOut: async (input?: { fetchOptions?: PerCallFetchOptions }) => {
				calls.push({ method: 'signOut' });
				if (!options.fetchOptions?.customFetchImpl) return { error: null };
				return callCustomFetch(options, '/sign-out', {
					method: 'POST',
					body: {},
					fetchOptions: input?.fetchOptions,
				});
			},
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

const { createBearerAuth, createCookieAuth } = await import('./index.js');

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

beforeEach(() => {
	listeners = new Set();
	currentState = { isPending: false, data: betterAuthSessionData(session()) };
	betterAuthOptions = null;
	calls = [];
	fetches = [];
	globalThis.fetch = (async (
		input: Request | string | URL,
		init?: RequestInit,
	) => {
		fetches.push({ input, init });
		return new Response(null, { status: 204 });
	}) as unknown as typeof fetch;
	console.error = () => {};
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

function identityFromSession(value: BearerSession): AuthIdentity {
	return {
		user: value.user,
		encryptionKeys: value.encryptionKeys,
	};
}

function signedInState(value: BearerSession): AuthState {
	return { status: 'signed-in', identity: identityFromSession(value) };
}

function betterAuthSessionData(value: BearerSession) {
	return {
		user: value.user,
		encryptionKeys: value.encryptionKeys,
	};
}

function rememberToken(token: string) {
	betterAuthOptions?.fetchOptions?.onSuccess?.({
		response: new Response(null, {
			headers: { 'set-auth-token': token },
		}),
	});
}

function emitSession(value: BearerSession | null) {
	if (value !== null) rememberToken(value.token);
	currentState = {
		isPending: false,
		data: value === null ? null : betterAuthSessionData(value),
	};
	for (const listener of listeners) listener(currentState);
}

type ContractCase = {
	name: string;
	create(): AuthClient;
	expectTransport(auth: AuthClient): void;
	expectSocialCalls(): void;
};

const contractCases: ContractCase[] = [
	{
		name: 'cookie',
		create() {
			return createCookieAuth({
				baseURL: 'http://localhost:8787',
				getSocialCallbackURL: () => 'http://localhost:5173/current',
				initialIdentity: identityFromSession(session()),
			});
		},
		expectTransport(auth) {
			expect(new Headers(fetches[0]?.init?.headers).has('Authorization')).toBe(
				false,
			);
			expect(fetches[0]?.init?.credentials).toBe('include');
			expect(auth.bearerToken).toBeNull();
			expect(betterAuthOptions?.fetchOptions?.auth).toBeUndefined();
			expect(betterAuthOptions?.fetchOptions?.credentials).toBeUndefined();
		},
		expectSocialCalls() {
			expect(calls).toContainEqual({
				method: 'signIn.social',
				input: {
					provider: 'google',
					callbackURL: 'http://localhost:5173/current',
				},
			});
		},
	},
	{
		name: 'bearer',
		create() {
			const sessionStorage: BearerSessionStorage = {
				get: () => session(),
				set: () => {},
			};
			const oauthAdapter: OAuthSocialSignInAdapter = {
				signInWithSocial: async () => Ok(null),
			};
			return createBearerAuth({
				baseURL: 'http://localhost:8787',
				sessionStorage,
				oauthAdapter,
			});
		},
		expectTransport(auth) {
			expect(new Headers(fetches[0]?.init?.headers).get('Authorization')).toBe(
				'Bearer token-2',
			);
			expect(fetches[0]?.init?.credentials).toBe('omit');
			expect(auth.bearerToken).toBe('token-2');
			expect(betterAuthOptions?.fetchOptions?.auth?.type).toBe('Bearer');
			expect(betterAuthOptions?.fetchOptions?.credentials).toBe('omit');
		},
		expectSocialCalls() {
			expect(calls).not.toContainEqual({
				method: 'signIn.social',
				input: { provider: 'google' },
			});
		},
	},
];

for (const contractCase of contractCases) {
	test(`${contractCase.name} factory satisfies the AuthClient contract`, async () => {
		const auth = contractCase.create();
		const states: AuthState[] = [];
		const unsubscribe = auth.onStateChange((state) => states.push(state));

		expect(auth.state).toEqual(signedInState(session()));

		emitSession(session({ userId: 'user-2', token: 'token-2' }));

		expect(states).toEqual([
			signedInState(session({ userId: 'user-2', token: 'token-2' })),
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
			await auth.signInWithSocial({ provider: 'google' }),
		).toEqual(Ok(undefined));

		await auth.fetch('http://localhost/api', {
			headers: { Authorization: 'Bearer caller-token' },
		});

		contractCase.expectTransport(auth);
		expect(calls.slice(0, 2)).toEqual([
			{
				method: 'signIn.email',
				input: { email: 'user@example.com', password: 'pw' },
			},
			{
				method: 'signUp.email',
				input: { email: 'user@example.com', password: 'pw', name: 'User' },
			},
		]);
		contractCase.expectSocialCalls();

		expect(await auth.signOut()).toEqual(Ok(undefined));
		expect(auth.state).toEqual({ status: 'signed-out' });
		expect(calls.at(-1)).toEqual({ method: 'signOut' });

		unsubscribe();
		auth[Symbol.dispose]();
		expect(listeners.size).toBe(0);
	});
}
