/**
 * Trusted OAuth Client Tests
 *
 * Verifies the first-party OAuth client registry and the Better Auth client
 * rows generated from it.
 *
 * Key behaviors:
 * - Trusted registry clients are projected as public PKCE clients
 * - Trusted clients skip consent during authorization
 * - Registered non-trusted clients still require consent
 */

import { expect, test } from 'bun:test';
import { EPICENTER_TRUSTED_OAUTH_CLIENTS } from '@epicenter/constants/oauth';
import { betterAuth } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { generateCodeChallenge } from 'better-auth/oauth2';
import { authPlugins } from './plugins.js';
import { projectTrustedOAuthClientToRow } from './trusted-oauth-clients.js';

const trustedClientDefinition = getTrustedClientDefinition();

const redirectUri = trustedClientDefinition.redirectUris[0];
const verifier = 'test-verifier-test-verifier-test-verifier';

test('trusted OAuth clients project to public PKCE client rows', () => {
	const row = projectTrustedOAuthClientToRow({
		clientId: 'trusted-client-1',
		name: 'Trusted Client',
		runtime: 'browser',
		redirectUris: [redirectUri],
	});

	expect(row).toMatchObject({
		id: 'trusted-client-1',
		clientId: 'trusted-client-1',
		name: 'Trusted Client',
		redirectUris: [redirectUri],
		tokenEndpointAuthMethod: 'none',
		grantTypes: ['authorization_code'],
		responseTypes: ['code'],
		scopes: ['openid', 'profile', 'email', 'offline_access', 'workspaces:open'],
		public: true,
		type: 'user-agent-based',
		requirePKCE: true,
		skipConsent: true,
	});
});

test('trusted OAuth client skips consent during authorization', async () => {
	const setup = createTrustedClientTestAuth();

	const cookie = await signUpTestUser(setup.auth, setup.baseURL);
	const code = await authorize(setup, {
		clientId: setup.trustedClientId,
		cookie,
	});

	expect(code).toBeTruthy();
});

test('trusted OAuth client exchanges code for API-origin access token', async () => {
	const setup = createTrustedClientTestAuth();

	const cookie = await signUpTestUser(setup.auth, setup.baseURL);
	const code = await authorize(setup, {
		clientId: setup.trustedClientId,
		cookie,
	});
	if (!code) throw new Error('Expected authorization code');

	const response = await exchangeCode(setup, {
		clientId: setup.trustedClientId,
		code,
	});
	const body = await response.json();
	const accessToken = readAccessToken(body);
	const payload = decodeJwtPayload(accessToken);
	const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

	expect(response.status).toBe(200);
	expect(audiences).toContain(setup.baseURL);
	expect(payload.iss).toBe(`${setup.baseURL}/auth`);
});

test('registered non-trusted OAuth client requires consent', async () => {
	const setup = createTrustedClientTestAuth();

	const cookie = await signUpTestUser(setup.auth, setup.baseURL);
	const response = await authorizeResponse(setup, {
		clientId: 'registered-client-1',
		cookie,
	});
	const location = response.headers.get('location');

	expect(response.status).toBe(302);
	expect(location).toBeTruthy();
	expect(new URL(location ?? setup.baseURL, setup.baseURL).pathname).toBe(
		'/consent',
	);
});

function createTrustedClientTestAuth() {
	const baseURL = 'http://localhost:47878';
	const trustedClient = projectTrustedOAuthClientToRow(trustedClientDefinition);
	const registeredClient = {
		...projectTrustedOAuthClientToRow({
			clientId: 'registered-client-1',
			name: 'Registered Client',
			runtime: 'browser',
			redirectUris: [redirectUri],
		}),
		skipConsent: false,
	};
	const db: MemoryDB = {
		user: [],
		session: [],
		account: [],
		verification: [],
		oauthClient: [trustedClient, registeredClient],
		oauthAccessToken: [],
		oauthConsent: [],
		oauthRefreshToken: [],
		jwks: [],
	};

	const auth = betterAuth({
		database: memoryAdapter(db),
		emailAndPassword: { enabled: true },
		basePath: '/auth',
		baseURL,
		secret: 'test-secret-test-secret-test-secret',
		plugins: authPlugins({ resourceAudience: baseURL }),
	});

	return { auth, baseURL, trustedClientId: trustedClient.clientId };
}

async function signUpTestUser(
	auth: ReturnType<typeof createTrustedClientTestAuth>['auth'],
	baseURL: string,
) {
	const response = await auth.handler(
		new Request(`${baseURL}/auth/sign-up/email`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				email: `trusted-client-${crypto.randomUUID()}@example.com`,
				password: 'password123',
				name: 'Trusted Client Test',
			}),
		}),
	);
	const cookie = response.headers.get('set-cookie');
	expect(cookie).toBeTruthy();
	return cookie ?? '';
}

async function authorize(
	setup: ReturnType<typeof createTrustedClientTestAuth>,
	input: { clientId: string; cookie: string },
) {
	const response = await authorizeResponse(setup, input);
	const location = response.headers.get('location');
	expect(location).toBeTruthy();
	return new URL(location ?? redirectUri).searchParams.get('code');
}

async function authorizeResponse(
	{ auth, baseURL }: ReturnType<typeof createTrustedClientTestAuth>,
	{ clientId, cookie }: { clientId: string; cookie: string },
) {
	const authorizeUrl = new URL(`${baseURL}/auth/oauth2/authorize`);
	for (const [key, value] of Object.entries({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: redirectUri,
		scope: 'openid profile email offline_access',
		state: 'state-1',
		code_challenge: await generateCodeChallenge(verifier),
		code_challenge_method: 'S256',
		resource: baseURL,
	})) {
		authorizeUrl.searchParams.set(key, value);
	}

	return auth.handler(
		new Request(authorizeUrl.toString(), { headers: { cookie } }),
	);
}

async function exchangeCode(
	{ auth, baseURL }: ReturnType<typeof createTrustedClientTestAuth>,
	{ clientId, code }: { clientId: string; code: string },
) {
	return auth.handler(
		new Request(`${baseURL}/auth/oauth2/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				code_verifier: verifier,
				client_id: clientId,
				redirect_uri: redirectUri,
				resource: baseURL,
			}),
		}),
	);
}

function decodeJwtPayload(token: string) {
	const [, payload] = token.split('.');
	if (!payload) throw new Error('Expected JWT access token');
	const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
	return JSON.parse(atob(padded)) as Record<string, unknown>;
}

function getTrustedClientDefinition() {
	const client = EPICENTER_TRUSTED_OAUTH_CLIENTS.find(
		(client) => client.clientId === 'epicenter-fuji',
	);
	if (!client) throw new Error('Expected test trusted client to exist');
	return client;
}

function readAccessToken(body: unknown) {
	if (
		body &&
		typeof body === 'object' &&
		'access_token' in body &&
		typeof body.access_token === 'string'
	) {
		return body.access_token;
	}
	return '';
}
