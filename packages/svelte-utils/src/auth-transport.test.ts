/**
 * Auth Transport Tests
 *
 * Verifies the Better Auth wrapper keeps bearer tokens fresh across transport
 * calls and maps Better Auth session payloads into Epicenter's local auth
 * contract.
 *
 * Key behaviors:
 * - Rotated bearer tokens are reused immediately by the client token callback
 * - `resolveSessionWithToken()` reads nested `session.token`
 * - Explicit empty `set-auth-token` headers clear the cached bearer token
 */

import { describe, expect, mock, test } from 'bun:test';

type CreateAuthClientOptions = {
	baseURL: string;
	basePath: string;
	fetchOptions: {
		auth: {
			type: 'Bearer';
			token: () => string | undefined;
		};
		onSuccess: ({ response }: { response: Response }) => void;
	};
};

type BetterAuthClientStub = {
	getSession: () => Promise<{ data: unknown; error: unknown }>;
	signIn: {
		email: (input: unknown) => Promise<{ data: unknown; error: unknown }>;
		social: (input: unknown) => Promise<{ data: unknown; error: unknown }>;
	};
	signUp: {
		email: (input: unknown) => Promise<{ data: unknown; error: unknown }>;
	};
	signOut: () => Promise<{ error: unknown }>;
};

async function setup({
	onCreateAuthClient,
}: {
	onCreateAuthClient?: (
		options: CreateAuthClientOptions,
	) => BetterAuthClientStub;
} = {}) {
	mock.module('better-auth/client', () => ({
		createAuthClient(options: CreateAuthClientOptions) {
			return (
				onCreateAuthClient?.(options) ?? {
					getSession: async () => ({ data: null, error: null }),
					signIn: {
						email: async () => ({ data: null, error: null }),
						social: async () => ({ data: null, error: null }),
					},
					signUp: {
						email: async () => ({ data: null, error: null }),
					},
					signOut: async () => ({ error: null }),
				}
			);
		},
	}));

	return await import(`./auth-transport.ts?test=${crypto.randomUUID()}`);
}

function createAuthClientStub({
	getSession = async () => ({ data: null, error: null }),
}: {
	getSession?: BetterAuthClientStub['getSession'];
} = {}): BetterAuthClientStub {
	return {
		getSession,
		signIn: {
			email: async () => ({ data: null, error: null }),
			social: async () => ({ data: null, error: null }),
		},
		signUp: {
			email: async () => ({ data: null, error: null }),
		},
		signOut: async () => ({ error: null }),
	};
}

function createAuthenticatedSessionPayload() {
	return {
		user: {
			id: 'user-1',
			createdAt: new Date('2026-03-28T00:00:00.000Z'),
			updatedAt: new Date('2026-03-28T00:00:00.000Z'),
			email: 'braden@example.com',
			emailVerified: true,
			name: 'Braden',
			image: null,
		},
		session: {
			token: 'rotated-token',
		},
		userKeyBase64: 'AQIDBA==',
	};
}

describe('createBetterAuthClientSession', () => {
	test('reuses rotated token immediately after a successful response', async () => {
		let tokenBeforeRotation: string | undefined;
		let tokenAfterRotation: string | undefined;

		const transport = await setup({
			onCreateAuthClient(options) {
				tokenBeforeRotation = options.fetchOptions.auth.token();
				options.fetchOptions.onSuccess({
					response: new Response(null, {
						headers: { 'set-auth-token': 'rotated-token' },
					}),
				});
				tokenAfterRotation = options.fetchOptions.auth.token();
				return createAuthClientStub();
			},
		});

		await transport
			.createAuthTransport({
				baseURL: 'https://example.com',
			})
			.resolveSession({
				status: 'authenticated',
				token: 'initial-token',
				user: {
					id: 'user-1',
					createdAt: '2026-03-28T00:00:00.000Z',
					updatedAt: '2026-03-28T00:00:00.000Z',
					email: 'braden@example.com',
					emailVerified: true,
					name: 'Braden',
					image: null,
				},
			});

		expect(tokenBeforeRotation).toBe('initial-token');
		expect(tokenAfterRotation).toBe('rotated-token');
	});

	test('empty set-auth-token clears the cached bearer token', async () => {
		let tokenAfterClear: string | undefined;

		const transport = await setup({
			onCreateAuthClient(options) {
				options.fetchOptions.onSuccess({
					response: new Response(null, {
						headers: { 'set-auth-token': '' },
					}),
				});
				tokenAfterClear = options.fetchOptions.auth.token();
				return createAuthClientStub();
			},
		});

		await transport
			.createAuthTransport({
				baseURL: 'https://example.com',
			})
			.resolveSession({
				status: 'authenticated',
				token: 'initial-token',
				user: {
					id: 'user-1',
					createdAt: '2026-03-28T00:00:00.000Z',
					updatedAt: '2026-03-28T00:00:00.000Z',
					email: 'braden@example.com',
					emailVerified: true,
					name: 'Braden',
					image: null,
				},
			});

		expect(tokenAfterClear).toBeUndefined();
	});
});

describe('createAuthTransport.resolveSession', () => {
	test('hydrates authenticated session from nested session.token', async () => {
		const transport = await setup({
			onCreateAuthClient() {
				return createAuthClientStub({
					getSession: async () => ({
						data: createAuthenticatedSessionPayload(),
						error: null,
					}),
				});
			},
		});

		const result = await transport
			.createAuthTransport({
				baseURL: 'https://example.com',
			})
			.resolveSession({
				status: 'anonymous',
			});

		expect(result).toEqual({
			status: 'authenticated',
			token: 'rotated-token',
			user: {
				id: 'user-1',
				createdAt: '2026-03-28T00:00:00.000Z',
				updatedAt: '2026-03-28T00:00:00.000Z',
				email: 'braden@example.com',
				emailVerified: true,
				name: 'Braden',
				image: null,
			},
			userKeyBase64: 'AQIDBA==',
		});
	});
});
