/**
 * Auth Transport Tests
 *
 * Verifies the auth transport maps Better Auth session payloads into
 * Epicenter's local auth contract.
 *
 * Key behaviors:
 * - `resolveSessionWithToken()` reads nested `session.token`
 * - Resolved token comes from remote session payload over caller input token
 */

import { describe, expect, mock, test } from 'bun:test';

type CreateAuthClientOptions = {
	baseURL: string;
	basePath: string;
	fetchOptions: {
		auth: {
			type: 'Bearer';
			token: string | undefined;
		};
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

	test('prefers token from session payload over input token', async () => {
		let clientToken: string | undefined;
		const transport = await setup({
			onCreateAuthClient(options) {
				clientToken = options.fetchOptions.auth.token;
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

		expect(clientToken).toBe('initial-token');
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
