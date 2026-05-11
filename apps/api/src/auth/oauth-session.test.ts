/**
 * OAuth Session Endpoint Tests
 *
 * Verifies the explicit bearer OAuth session endpoint used by browser
 * clients after an OAuth 2.1 PKCE exchange.
 *
 * Key behaviors:
 * - Authorization-code plus PKCE token exchange with resource returns a JWT
 * - `/auth/oauth-session` returns the enriched session and durable session token
 * - Invalid access tokens and expired Better Auth sessions are rejected
 */

import { expect, test } from 'bun:test';
import { oauthProvider } from '@better-auth/oauth-provider';
import type { BetterAuthSessionResponse } from '@epicenter/auth/contracts';
import type { EncryptionKeys } from '@epicenter/encryption';
import { betterAuth, type Session, type User } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { generateCodeChallenge } from 'better-auth/oauth2';
import { customSession, jwt } from 'better-auth/plugins';
import { bearer } from 'better-auth/plugins/bearer';
import { resolveOAuthBearerSession } from './oauth-session.js';
import { createBetterAuthSessionResponse } from './session-response.js';

const redirectUri = 'http://localhost:5174/auth/callback';
const verifier = 'test-verifier-test-verifier-test-verifier';
const encryptionKeys: EncryptionKeys = [
	{
		version: 1,
		userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
];
let nextOAuthSessionTestPort = 31_000 + Math.floor(Math.random() * 10_000);

test('oauth-session returns enriched session for OAuth access token', async () => {
	const setup = createOAuthSessionTestServer();

	try {
		const token = await issueOAuthAccessToken(setup);
		expect(token.split('.')).toHaveLength(3);

		const response = await fetch(`${setup.baseURL}/auth/oauth-session`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` },
		});

		expect(response.status).toBe(200);
		const session = setup.db.session?.[0];
		expect(session).toBeTruthy();
		expect(response.headers.get('set-auth-token')).toBe(session?.token);
			const body = (await response.json()) as BetterAuthSessionResponse;
		expect(body.user.email).toBe('oauth-session@example.com');
		expect(body.encryptionKeys).toEqual(encryptionKeys);
	} finally {
		setup.server.stop(true);
	}
});

test('oauth-session rejects invalid OAuth access tokens', async () => {
	const setup = createOAuthSessionTestServer();

	try {
		const response = await fetch(`${setup.baseURL}/auth/oauth-session`, {
			method: 'POST',
			headers: { authorization: 'Bearer invalid-token' },
		});

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({
			code: 'invalid_oauth_token',
		});
	} finally {
		setup.server.stop(true);
	}
});

test('oauth-session rejects malformed bearer input', async () => {
	const setup = createOAuthSessionTestServer();

	try {
		const response = await fetch(`${setup.baseURL}/auth/oauth-session`, {
			method: 'POST',
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			code: 'malformed_oauth_token',
		});
	} finally {
		setup.server.stop(true);
	}
});

test('oauth-session rejects expired Better Auth sessions', async () => {
	const setup = createOAuthSessionTestServer();

	try {
		const token = await issueOAuthAccessToken(setup);
		const session = setup.db.session?.[0];
		expect(session).toBeTruthy();
		if (session) {
			session.expiresAt = new Date(Date.now() - 60_000);
		}

		const response = await fetch(`${setup.baseURL}/auth/oauth-session`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` },
		});

		expect(response.status).toBe(401);
	} finally {
		setup.server.stop(true);
	}
});

function createOAuthSessionTestServer() {
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
		const port = nextOAuthSessionTestPort++;
		const baseURL = `http://localhost:${port}`;
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
				validAudiences: [baseURL],
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
						createBetterAuthSessionResponse(input, {
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
					if (
						request.method === 'POST' &&
						url.pathname === '/auth/oauth-session'
					) {
						const result = await resolveOAuthBearerSession({
							authorization: request.headers.get('authorization'),
							baseURL,
							createSessionResponse: (input) =>
								createBetterAuthSessionResponse(input, {
									deriveUserEncryptionKeys: async () => encryptionKeys,
								}),
							findSessionWithUserById: (sessionId) =>
								findSessionWithUserById(db, sessionId),
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
						return Response.json(result.body, {
							headers: { 'set-auth-token': result.sessionToken },
						});
					}
					return auth.handler(request);
				},
			});

			return { auth, baseURL, db, server };
		} catch (error) {
			if (isAddressInUse(error)) continue;
			throw error;
		}
	}

	throw new Error('Failed to find an available OAuth session test port.');
}

function isAddressInUse(error: unknown) {
	return (
		error instanceof Error &&
		'code' in error &&
		(error as { code?: unknown }).code === 'EADDRINUSE'
	);
}

async function issueOAuthAccessToken({
	auth,
	baseURL,
}: ReturnType<typeof createOAuthSessionTestServer>) {
	const signUpResponse = await auth.handler(
		new Request(`${baseURL}/auth/sign-up/email`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				email: 'oauth-session@example.com',
				password: 'password123',
				name: 'OAuth Session',
			}),
		}),
	);
	const cookie = signUpResponse.headers.get('set-cookie');
	expect(cookie).toBeTruthy();

	const client = (await auth.api.adminCreateOAuthClient({
		body: {
			client_name: 'Fuji Local Test',
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code'],
			response_types: ['code'],
			scope: 'openid profile email',
			skip_consent: true,
			require_pkce: true,
		},
	})) as { client_id: string };
	const authorizeUrl = new URL(`${baseURL}/auth/oauth2/authorize`);
	for (const [key, value] of Object.entries({
		response_type: 'code',
		client_id: client.client_id,
		redirect_uri: redirectUri,
		scope: 'openid profile email',
		state: 'state-1',
		code_challenge: await generateCodeChallenge(verifier),
		code_challenge_method: 'S256',
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
				resource: baseURL,
			}),
		}),
	);
	expect(tokenResponse.status).toBe(200);
	const tokenBody = (await tokenResponse.json()) as { access_token: string };
	return tokenBody.access_token;
}

async function findSessionWithUserById(
	db: MemoryDB,
	sessionId: string,
): Promise<{ session: Session; user: User } | null> {
	const session = db.session?.find((value) => value.id === sessionId);
	if (!session) return null;
	const user = db.user?.find((value) => value.id === session.userId);
	if (!user) return null;
	return { session, user };
}
