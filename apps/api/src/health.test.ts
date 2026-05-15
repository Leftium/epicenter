/**
 * /api/health bearer-liveness probe tests.
 *
 * The CLI's `epicenter auth status` pings `/api/health` to verify the current
 * access token is still valid after a local id_token decode. The route sits
 * behind the same `requireOAuthUser` middleware as `/ai/*`, `/rooms/*`, etc.,
 * so a missing or malformed bearer surfaces as 401, and a valid scoped bearer
 * passes through to a plain 'ok' body.
 *
 * Built on a minimal memory-adapter Better Auth instance plus the pure bearer
 * user resolver behind the Hono adapter wired in `app.ts`.
 */

import { expect, test } from 'bun:test';
import { oauthProvider } from '@better-auth/oauth-provider';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import type { AuthUser } from '@epicenter/auth';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { jwt } from 'better-auth/plugins';
import { Hono } from 'hono';
import { createOAuthUnauthorizedResourceResponse } from './auth/oauth-resource.js';
import { resolveBearerUser } from './auth/resource-boundary.js';
import {
	createOAuthTestDb,
	isAddressInUse,
	issueOAuthTokens,
} from './test-helpers/oauth.js';

type HealthEnv = { Variables: { user: AuthUser } };

let nextHealthTestPort = 56_000 + Math.floor(Math.random() * 4_000);

test('GET /api/health returns 200 with a valid scoped bearer', async () => {
	const setup = createHealthTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Health Test Client',
			email: 'health-test@example.com',
			name: 'Health Test',
		});
		const response = await setup.app.request('/api/health', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
	} finally {
		setup.server.stop(true);
	}
});

test('GET /api/health returns 401 without a bearer', async () => {
	const setup = createHealthTestServer();
	try {
		const response = await setup.app.request('/api/health');

		expect(response.status).toBe(401);
		expect(response.headers.get('WWW-Authenticate')).toBe(
			'Bearer error="invalid_token"',
		);
	} finally {
		setup.server.stop(true);
	}
});

test('GET /api/health returns 403 when scoped without workspaces:open', async () => {
	const setup = createHealthTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Health Test Client',
			email: 'health-test@example.com',
			name: 'Health Test',
			scope: 'openid profile email offline_access',
		});
		const response = await setup.app.request('/api/health', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(403);
		expect(response.headers.get('WWW-Authenticate')).toBe(
			'Bearer error="insufficient_scope" scope="workspaces:open"',
		);
	} finally {
		setup.server.stop(true);
	}
});

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

function createHealthTestServer() {
	const db = createOAuthTestDb();

	for (let attempt = 0; attempt < 40; attempt += 1) {
		const port = nextHealthTestPort++;
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
			const app = new Hono<HealthEnv>();
			app.use('/api/health', async (c, next) => {
				const { data: user, error } = await resolveBearerUser({
					authorization: c.req.header('authorization') ?? null,
					audience: baseURL,
					issuer: `${baseURL}/auth`,
					jwksUrl: `${baseURL}/auth/jwks`,
					verifyOAuthAccessToken: resource.getActions().verifyAccessToken,
					findUserById: async (userId) =>
						db.user?.find((u) => u.id === userId) ?? null,
				});
				if (error) return createOAuthUnauthorizedResourceResponse(c, error);
				c.set('user', user);
				await next();
			});
			app.get('/api/health', (c) => c.text('ok'));

			return { auth, baseURL, db, server, app };
		} catch (error) {
			if (isAddressInUse(error)) continue;
			throw error;
		}
	}

	throw new Error('Failed to find an available health test port.');
}
