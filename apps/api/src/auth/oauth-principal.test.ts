/**
 * Protected Resource Principal Tests
 *
 * Verifies `resolveOAuthPrincipal`, the cheaper resolver that protected app
 * resource middleware (`/ai/*`, `/workspaces/*`, `/documents/*`,
 * `/api/billing/*`, `/api/assets/*`) uses to prove a calling user and the
 * `workspaces:open` scope before route handlers run.
 *
 * Key behaviors:
 * - Valid scoped tokens resolve to the calling user
 * - Missing the `workspaces:open` scope returns `insufficient_scope`
 * - Audience and issuer mismatches map to invalid OAuth credentials
 * - Malformed bearer input is rejected before any verification call
 * - Tokens whose subject no longer exists map to invalid
 */

import { expect, test } from 'bun:test';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import { betterAuth } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { generateCodeChallenge } from 'better-auth/oauth2';
import { jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import { resolveOAuthPrincipal } from './oauth-principal.js';

const redirectUri = 'http://localhost:5174/auth/callback';
const verifier = 'test-verifier-test-verifier-test-verifier';
let nextPrincipalTestPort = 51_000 + Math.floor(Math.random() * 10_000);

test('resolveOAuthPrincipal resolves a valid scoped token to the calling user', async () => {
	const setup = createPrincipalTestServer();

	try {
		const { accessToken } = await issueOAuthTokens(setup);
		const { data, error } = await callResolver(setup, accessToken);

		expect(error).toBeNull();
		expect(data).toEqual({
			id: expect.any(String),
			email: 'principal-test@example.com',
		});
	} finally {
		setup.server.stop(true);
	}
});

test('resolveOAuthPrincipal rejects tokens missing the workspaces:open scope', async () => {
	const setup = createPrincipalTestServer();

	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			scope: 'openid profile email offline_access',
		});
		const { data, error } = await callResolver(setup, accessToken);

		expect(data).toBeNull();
		expect(error?.name).toBe('InsufficientScope');
		expect(error?.name === 'InsufficientScope' && error.scope).toBe(
			'workspaces:open',
		);
	} finally {
		setup.server.stop(true);
	}
});

test('resolveOAuthPrincipal rejects tokens issued for the wrong audience as InvalidToken', async () => {
	const setup = createPrincipalTestServer();

	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			resource: setup.wrongAudience,
		});
		const { data, error } = await callResolver(setup, accessToken);

		expect(data).toBeNull();
		expect(error?.name).toBe('InvalidToken');
	} finally {
		setup.server.stop(true);
	}
});

test('resolveOAuthPrincipal rejects tokens verified against the wrong issuer as InvalidToken', async () => {
	const setup = createPrincipalTestServer();

	try {
		const { accessToken } = await issueOAuthTokens(setup);
		const { data, error } = await callResolver(setup, accessToken, {
			issuer: `${setup.baseURL}/some-other-issuer`,
		});

		expect(data).toBeNull();
		expect(error?.name).toBe('InvalidToken');
	} finally {
		setup.server.stop(true);
	}
});

test('resolveOAuthPrincipal rejects malformed bearer input as InvalidToken before verifying', async () => {
	let verifierCalls = 0;
	const { data, error } = await resolveOAuthPrincipal({
		authorization: 'Token not-a-bearer',
		audience: 'http://localhost:8787',
		issuer: 'http://localhost:8787/auth',
		jwksUrl: 'http://localhost:8787/auth/jwks',
		verifyOAuthAccessToken: async () => {
			verifierCalls += 1;
			return null as never;
		},
		findUserById: async () => {
			throw new Error('findUserById should not run');
		},
	});

	expect(data).toBeNull();
	expect(error?.name).toBe('InvalidToken');
	expect(verifierCalls).toBe(0);
});

test('resolveOAuthPrincipal rejects tokens whose user no longer exists as InvalidToken', async () => {
	const setup = createPrincipalTestServer();

	try {
		const { accessToken } = await issueOAuthTokens(setup);
		setup.db.user = [];

		const { data, error } = await callResolver(setup, accessToken);

		expect(data).toBeNull();
		expect(error?.name).toBe('InvalidToken');
	} finally {
		setup.server.stop(true);
	}
});

function createPrincipalTestServer() {
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
		const port = nextPrincipalTestPort++;
		const baseURL = `http://localhost:${port}`;
		const wrongAudience = `${baseURL}/other-resource`;
		const auth = betterAuth({
			database: memoryAdapter(db),
			emailAndPassword: { enabled: true },
			basePath: '/auth',
			baseURL,
			secret: 'test-secret-test-secret-test-secret',
			plugins: [
				jwt(),
				oauthProvider({
					loginPage: '/sign-in',
					consentPage: '/consent',
					requirePKCE: true,
					validAudiences: [baseURL, wrongAudience],
					allowDynamicClientRegistration: false,
					scopes: [
						'openid',
						'profile',
						'email',
						'offline_access',
						'workspaces:open',
					],
					silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
				}),
			],
		});

		try {
			const server = Bun.serve({
				port,
				fetch: async (request) => auth.handler(request),
			});

			return { auth, baseURL, db, server, wrongAudience };
		} catch (error) {
			if (isAddressInUse(error)) continue;
			throw error;
		}
	}

	throw new Error('Failed to find an available OAuth principal test port.');
}

function isAddressInUse(error: unknown) {
	return (
		error instanceof Error &&
		'code' in error &&
		(error as { code?: unknown }).code === 'EADDRINUSE'
	);
}

async function callResolver(
	setup: ReturnType<typeof createPrincipalTestServer>,
	accessToken: string,
	overrides: { audience?: string; issuer?: string } = {},
) {
	const resource = oauthProviderResourceClient();
	return resolveOAuthPrincipal({
		authorization: `Bearer ${accessToken}`,
		audience: overrides.audience ?? setup.baseURL,
		issuer: overrides.issuer ?? `${setup.baseURL}/auth`,
		jwksUrl: `${setup.baseURL}/auth/jwks`,
		verifyOAuthAccessToken: resource.getActions().verifyAccessToken,
		findUserById: async (userId) =>
			setup.db.user?.find((user) => user.id === userId) ?? null,
	});
}

async function issueOAuthTokens(
	{ auth, baseURL }: ReturnType<typeof createPrincipalTestServer>,
	{
		resource = baseURL,
		scope = 'openid profile email offline_access workspaces:open',
	}: { resource?: string; scope?: string } = {},
) {
	const signUpResponse = await auth.handler(
		new Request(`${baseURL}/auth/sign-up/email`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				email: 'principal-test@example.com',
				password: 'password123',
				name: 'Principal Test',
			}),
		}),
	);
	const cookie = signUpResponse.headers.get('set-cookie');
	expect(cookie).toBeTruthy();

	const client = (await auth.api.adminCreateOAuthClient({
		body: {
			client_name: 'OAuth Principal Test',
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
		resource,
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
