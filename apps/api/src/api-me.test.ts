/**
 * GET /api/me integration tests.
 *
 * The current-user endpoint replaces /workspace-identity as the single
 * Epicenter identity surface clients fetch once after sign-in. It returns
 * { user: AuthUser, encryptionKeys: EncryptionKeys }; unauthenticated or
 * under-scoped callers get RFC 6750-shaped errors via
 * createOAuthUnauthorizedResourceResponse.
 *
 * Built on a minimal memory-adapter Better Auth instance plus the real
 * resolveRequestWorkspaceIdentity helper (wired in app.ts).
 */

import { expect, test } from 'bun:test';
import { oauthProvider } from '@better-auth/oauth-provider';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import type { EncryptionKeys } from '@epicenter/encryption';
import { betterAuth } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { generateCodeChallenge } from 'better-auth/oauth2';
import { jwt } from 'better-auth/plugins';
import { Hono } from 'hono';
import { createOAuthUnauthorizedResourceResponse } from './auth/oauth-resource.js';
import { resolveBearerIdentity } from './auth/resource-boundary.js';

const redirectUri = 'http://localhost:5174/auth/callback';
const verifier = 'test-verifier-test-verifier-test-verifier';
const encryptionKeys: EncryptionKeys = [
	{
		version: 1,
		userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
];
let nextApiMeTestPort = 47_000 + Math.floor(Math.random() * 4_000);

test('GET /api/me returns user + encryption keys for a valid scoped bearer', async () => {
	const setup = createApiMeTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup);
		const response = await setup.app.request('/api/me', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			user: { id: string; email: string };
			encryptionKeys: EncryptionKeys;
		};
		expect(body.user.email).toBe('api-me-test@example.com');
		expect(typeof body.user.id).toBe('string');
		expect(body.encryptionKeys).toEqual(encryptionKeys);
	} finally {
		setup.server.stop(true);
	}
});

test('GET /api/me returns 401 without a bearer', async () => {
	const setup = createApiMeTestServer();
	try {
		const response = await setup.app.request('/api/me');

		expect(response.status).toBe(401);
		expect(response.headers.get('WWW-Authenticate')).toBe(
			'Bearer error="invalid_token"',
		);
		const body = (await response.json()) as { name: string };
		expect(body.name).toBe('InvalidToken');
	} finally {
		setup.server.stop(true);
	}
});

test('GET /api/me returns 403 when the token lacks workspaces:open scope', async () => {
	const setup = createApiMeTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			scope: 'openid profile email offline_access',
		});
		const response = await setup.app.request('/api/me', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(403);
		expect(response.headers.get('WWW-Authenticate')).toBe(
			'Bearer error="insufficient_scope" scope="workspaces:open"',
		);
		const body = (await response.json()) as { name: string; scope: string };
		expect(body.name).toBe('InsufficientScope');
		expect(body.scope).toBe('workspaces:open');
	} finally {
		setup.server.stop(true);
	}
});

test('GET /api/me returns 401 for a malformed bearer', async () => {
	const setup = createApiMeTestServer();
	try {
		const response = await setup.app.request('/api/me', {
			headers: { authorization: 'Token not-a-bearer' },
		});

		expect(response.status).toBe(401);
	} finally {
		setup.server.stop(true);
	}
});

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

function createApiMeTestServer() {
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
		const port = nextApiMeTestPort++;
		const baseURL = `http://localhost:${port}`;
		const auth = betterAuth({
			database: memoryAdapter(db),
			emailAndPassword: { enabled: true },
			basePath: '/auth',
			baseURL,
			secret: 'test-secret-test-secret-test-secret',
			plugins: [
				jwt({ jwks: { keyPairConfig: { alg: 'ES256' } } }),
				oauthProvider({
					loginPage: '/sign-in',
					consentPage: '/consent',
					requirePKCE: true,
					validAudiences: [baseURL],
					allowDynamicClientRegistration: false,
					scopes: [
						'openid',
						'profile',
						'email',
						'offline_access',
						'workspaces:open',
					],
					silenceWarnings: {
						oauthAuthServerConfig: true,
						openidConfig: true,
					},
				}),
			],
		});

		try {
			const server = Bun.serve({
				port,
				fetch: async (request) => auth.handler(request),
			});

			const resource = oauthProviderResourceClient();
			const app = new Hono();
			app.get('/api/me', async (c) => {
				const { data: identity, error } = await resolveBearerIdentity({
					authorization: c.req.header('authorization') ?? null,
					audience: baseURL,
					issuer: `${baseURL}/auth`,
					jwksUrl: `${baseURL}/auth/jwks`,
					verifyOAuthAccessToken: resource.getActions().verifyAccessToken,
					findUserById: async (userId) =>
						db.user?.find((u) => u.id === userId) ?? null,
					deriveUserEncryptionKeys: async () => encryptionKeys,
				});
				if (error) return createOAuthUnauthorizedResourceResponse(c, error);
				return c.json(identity);
			});

			return { auth, baseURL, db, server, app };
		} catch (error) {
			if (isAddressInUse(error)) continue;
			throw error;
		}
	}

	throw new Error('Failed to find an available /api/me test port.');
}

function isAddressInUse(error: unknown) {
	return (
		error instanceof Error &&
		'code' in error &&
		(error as { code?: unknown }).code === 'EADDRINUSE'
	);
}

async function issueOAuthTokens(
	{ auth, baseURL }: ReturnType<typeof createApiMeTestServer>,
	{
		scope = 'openid profile email offline_access workspaces:open',
	}: { scope?: string } = {},
) {
	const signUpResponse = await auth.handler(
		new Request(`${baseURL}/auth/sign-up/email`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				email: 'api-me-test@example.com',
				password: 'password123',
				name: 'Api Me Test',
			}),
		}),
	);
	const cookie = signUpResponse.headers.get('set-cookie');
	expect(cookie).toBeTruthy();

	const client = (await auth.api.adminCreateOAuthClient({
		body: {
			client_name: 'Api Me Test Client',
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code'],
			response_types: ['code'],
			scope: 'openid profile email offline_access workspaces:open',
			skip_consent: true,
			require_pkce: true,
		},
	})) as { client_id: string };

	const authorizeUrl = new URL(`${baseURL}/auth/oauth2/authorize`);
	for (const [key, value] of Object.entries({
		response_type: 'code',
		client_id: client.client_id,
		redirect_uri: redirectUri,
		scope,
		state: 'state-1',
		code_challenge: await generateCodeChallenge(verifier),
		code_challenge_method: 'S256',
		resource: baseURL,
	})) {
		authorizeUrl.searchParams.set(key, value);
	}

	const authorizeResponse = await auth.handler(
		new Request(authorizeUrl.toString(), {
			headers: { cookie: cookie ?? '' },
		}),
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
				resource: baseURL,
			}),
		}),
	);
	expect(tokenResponse.status).toBe(200);
	const tokenBody = (await tokenResponse.json()) as { access_token: string };
	return { accessToken: tokenBody.access_token };
}
