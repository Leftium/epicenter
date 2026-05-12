/**
 * OAuth Identity Endpoint Tests
 *
 * Verifies the Epicenter resource-server identity endpoint used by apps after
 * completing OAuth authorization code with PKCE.
 *
 * Key behaviors:
 * - `/auth/me` returns the local-first identity for a valid OAuth access token
 * - Audience mismatches, missing users, and malformed bearer input are rejected
 * - Access-token verification failures map to invalid OAuth credentials
 */

import { expect, test } from 'bun:test';
import { oauthProvider } from '@better-auth/oauth-provider';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import type { WorkspaceIdentity } from '@epicenter/auth';
import type { EncryptionKeys } from '@epicenter/encryption';
import { betterAuth } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { generateCodeChallenge } from 'better-auth/oauth2';
import { customSession, jwt } from 'better-auth/plugins';
import { bearer } from 'better-auth/plugins/bearer';
import { createAuthIdentityResponse } from './identity-response.js';
import { resolveOAuthIdentity } from './me.js';

const redirectUri = 'http://localhost:5174/auth/callback';
const verifier = 'test-verifier-test-verifier-test-verifier';
const encryptionKeys: EncryptionKeys = [
	{
		version: 1,
		userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
];
let nextOAuthIdentityTestPort = 41_000 + Math.floor(Math.random() * 10_000);

test('auth/me returns identity for a valid OAuth access token', async () => {
	const setup = createOAuthIdentityTestServer();

	try {
		const { accessToken, refreshToken } = await issueOAuthTokens(setup);
		expect(accessToken.split('.')).toHaveLength(3);
		expect(refreshToken).toBeTruthy();

		const response = await fetch(`${setup.baseURL}/auth/me`, {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('set-auth-token')).toBeNull();
		const body = (await response.json()) as WorkspaceIdentity;
		expect(body.user.email).toBe('oauth-identity@example.com');
		expect(body).not.toHaveProperty('session');
		expect(body.encryptionKeys).toEqual(encryptionKeys);
	} finally {
		setup.server.stop(true);
	}
});

test('auth/me rejects missing bearer input', async () => {
	const setup = createOAuthIdentityTestServer();

	try {
		const response = await fetch(`${setup.baseURL}/auth/me`);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			code: 'malformed_oauth_token',
		});
	} finally {
		setup.server.stop(true);
	}
});

test('auth/me rejects access tokens with the wrong audience', async () => {
	const setup = createOAuthIdentityTestServer();

	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			resource: setup.wrongAudience,
		});

		const response = await fetch(`${setup.baseURL}/auth/me`, {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({
			code: 'invalid_oauth_token',
		});
	} finally {
		setup.server.stop(true);
	}
});

test('auth/me rejects tokens whose user no longer exists', async () => {
	const setup = createOAuthIdentityTestServer();

	try {
		const { accessToken } = await issueOAuthTokens(setup);
		setup.db.user = [];

		const response = await fetch(`${setup.baseURL}/auth/me`, {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({
			code: 'invalid_oauth_token',
		});
	} finally {
		setup.server.stop(true);
	}
});

test('resolveOAuthIdentity rejects expired access-token verification', async () => {
	const result = await resolveOAuthIdentity({
		authorization: 'Bearer expired-token',
		audience: 'http://localhost:8787',
		issuer: 'http://localhost:8787/auth',
		jwksUrl: 'http://localhost:8787/auth/jwks',
		verifyOAuthAccessToken: async () => {
			throw new Error('JWTExpired');
		},
		findUserById: async () => {
			throw new Error('findUserById should not run');
		},
		deriveUserEncryptionKeys: async () => {
			throw new Error('deriveUserEncryptionKeys should not run');
		},
	});

	expect(result).toEqual({ status: 'invalid' });
});

function createOAuthIdentityTestServer() {
	const db: MemoryDB = {
		user: [],
		session: [],
		account: [],
		verification: [],
		oauthClient: [],
		oauthAccessToken: [],
		oauthConsent: [],
		oauthRefreshToken: [],
		jwks: [],
	};

	for (let attempt = 0; attempt < 40; attempt += 1) {
		const port = nextOAuthIdentityTestPort++;
		const baseURL = `http://localhost:${port}`;
		const wrongAudience = `${baseURL}/other-resource`;
		const baseAuthOptions = {
			database: memoryAdapter(db),
			emailAndPassword: { enabled: true },
			basePath: '/auth',
			baseURL,
			secret: 'test-secret-test-secret-test-secret',
		};
		const basePlugins = [
			bearer(),
			jwt(),
			oauthProvider({
				loginPage: '/sign-in',
				consentPage: '/consent',
				requirePKCE: true,
				validAudiences: [baseURL, wrongAudience],
				allowDynamicClientRegistration: false,
				silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
			}),
		];
		const auth = betterAuth({
			...baseAuthOptions,
			plugins: [
				...basePlugins,
				customSession(
					(input) =>
						createAuthIdentityResponse(input, {
							deriveUserEncryptionKeys: async () => encryptionKeys,
						}),
					{ ...baseAuthOptions, plugins: basePlugins },
				),
			],
		});

		try {
			const server = Bun.serve({
				port,
				fetch: async (request) => {
					const url = new URL(request.url);
					if (request.method === 'GET' && url.pathname === '/auth/me') {
						const resource = oauthProviderResourceClient();
						const result = await resolveOAuthIdentity({
							authorization: request.headers.get('authorization'),
							audience: baseURL,
							issuer: `${baseURL}/auth`,
							jwksUrl: `${baseURL}/auth/jwks`,
							verifyOAuthAccessToken: resource.getActions().verifyAccessToken,
							findUserById: async (userId) =>
								db.user?.find((user) => user.id === userId) ?? null,
							deriveUserEncryptionKeys: async () => encryptionKeys,
						});
						if (result.status === 'malformed') {
							return Response.json(
								{ code: 'malformed_oauth_token' },
								{ status: 400 },
							);
						}
						if (result.status === 'invalid') {
							return Response.json(
								{ code: 'invalid_oauth_token' },
								{ status: 401 },
							);
						}
						return Response.json(result.body);
					}
					return auth.handler(request);
				},
			});

			return { auth, baseURL, db, server, wrongAudience };
		} catch (error) {
			if (isAddressInUse(error)) continue;
			throw error;
		}
	}

	throw new Error('Failed to find an available OAuth identity test port.');
}

function isAddressInUse(error: unknown) {
	return (
		error instanceof Error &&
		'code' in error &&
		(error as { code?: unknown }).code === 'EADDRINUSE'
	);
}

async function issueOAuthTokens(
	{ auth, baseURL }: ReturnType<typeof createOAuthIdentityTestServer>,
	{ resource = baseURL }: { resource?: string } = {},
) {
	const signUpResponse = await auth.handler(
		new Request(`${baseURL}/auth/sign-up/email`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				email: 'oauth-identity@example.com',
				password: 'password123',
				name: 'OAuth Identity',
			}),
		}),
	);
	const cookie = signUpResponse.headers.get('set-cookie');
	expect(cookie).toBeTruthy();

	const client = (await auth.api.adminCreateOAuthClient({
		body: {
			client_name: 'OAuth Identity Test',
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code'],
			response_types: ['code'],
			scope: 'openid profile email offline_access',
			skip_consent: true,
			require_pkce: true,
		},
	})) as { client_id: string };
	const authorizeUrl = new URL(`${baseURL}/auth/oauth2/authorize`);
	for (const [key, value] of Object.entries({
		response_type: 'code',
		client_id: client.client_id,
		redirect_uri: redirectUri,
		scope: 'openid profile email offline_access',
		state: 'state-1',
		code_challenge: await generateCodeChallenge(verifier),
		code_challenge_method: 'S256',
		resource,
	})) {
		authorizeUrl.searchParams.set(key, value);
	}

	const authorizeResponse = await auth.handler(
		new Request(authorizeUrl.toString(), { headers: { cookie: cookie ?? '' } }),
	);
	const location = authorizeResponse.headers.get('location');
	expect(location).toBeTruthy();
	const code = new URL(location ?? redirectUri).searchParams.get('code');
	expect(code).toBeTruthy();

	const tokenResponse = await auth.handler(
		new Request(`${baseURL}/auth/oauth2/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: client.client_id,
				redirect_uri: redirectUri,
				code: code ?? '',
				code_verifier: verifier,
				resource,
			}),
		}),
	);
	expect(tokenResponse.status).toBe(200);
	const tokenBody = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token?: string;
	};
	return {
		accessToken: tokenBody.access_token,
		refreshToken: tokenBody.refresh_token ?? null,
	};
}
