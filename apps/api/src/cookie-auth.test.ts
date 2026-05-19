/**
 * Cookie-auth invariants for the portal/API split
 * (specs/20260517T230000-portal-and-auth-collapse.md).
 *
 * Two contracts pinned here:
 *
 * 1. Same-site cross-origin cookie. After the split the API runs on
 *    `localhost:<API_PORT>` and the portal on `localhost:<PORTAL_PORT>`.
 *    They are cross-origin but same-site (both reduce to the registrable
 *    domain `localhost`), so Better Auth's default `SameSite=Lax` session
 *    cookie SHOULD attach to a `credentials: 'include'` fetch from portal
 *    to API. If a future Better Auth change breaks the assumption (e.g.
 *    a plugin upgrading SameSite to Strict), the dev-loop fallback in
 *    section 6 of the spec kicks in.
 *
 * 2. CSRF guard on cookie-auth mutations. `POST/PUT/DELETE/PATCH /api/*`
 *    from a non-trusted origin with a forwarded cookie must be rejected,
 *    while bearer-auth requests (which are CSRF-immune) skip the check
 *    even with no `Origin`. The Hono mounting and request shape mirror
 *    `app.ts`; the middleware itself is imported, not duplicated.
 */

import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { Hono } from 'hono';
import { requireOriginForCookieMutations } from './auth/csrf.js';
import { createOAuthTestDb, isAddressInUse } from './test-helpers/oauth.js';

const PORTAL_ORIGIN = 'http://localhost:5178';
let nextPort = 53_000 + Math.floor(Math.random() * 3_000);

test('Better Auth session cookie attaches to same-site cross-origin fetch from portal origin', async () => {
	const setup = createCookieAuthTestServer();
	try {
		// 1. Sign-up sets the session cookie on the API origin.
		const email = `cookie-auth-${Date.now()}@example.com`;
		const signUp = await fetch(`${setup.baseURL}/auth/sign-up/email`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: setup.baseURL,
			},
			body: JSON.stringify({
				email,
				password: 'password123',
				name: 'Cookie Auth Test',
			}),
		});
		expect(signUp.status).toBe(200);

		const setCookie = signUp.headers.get('set-cookie');
		expect(setCookie).toBeTruthy();
		expect(setCookie).toMatch(/session_token/i);
		const cookie = (setCookie as string).split(';')[0]!;

		// 2. Cross-origin (portal) → API call with the cookie. Browsers attach
		//    SameSite=Lax cookies for fetches initiated by same-site origins;
		//    this asserts Better Auth resolves such a cookie to a valid session.
		const sessionRes = await fetch(`${setup.baseURL}/auth/get-session`, {
			headers: {
				cookie,
				origin: PORTAL_ORIGIN,
			},
		});
		expect(sessionRes.status).toBe(200);
		const body = (await sessionRes.json()) as {
			user?: { email?: string };
		} | null;
		expect(body?.user?.email).toBe(email);
	} finally {
		setup.server.stop(true);
	}
});

test('CSRF guard rejects cookie-auth POST from a non-trusted origin', async () => {
	const app = createCsrfTestApp();
	const res = await app.request('/api/billing/upgrade', {
		method: 'POST',
		headers: {
			cookie: 'better-auth.session_token=abc123',
			origin: 'https://evil.example',
			'content-type': 'application/json',
		},
		body: '{}',
	});
	expect(res.status).toBe(403);
	const body = (await res.json()) as { name: string };
	expect(body.name).toBe('forbidden_origin');
});

test('CSRF guard rejects cookie-auth POST with no Origin header', async () => {
	const app = createCsrfTestApp();
	const res = await app.request('/api/billing/upgrade', {
		method: 'POST',
		headers: {
			cookie: 'better-auth.session_token=abc123',
			'content-type': 'application/json',
		},
		body: '{}',
	});
	expect(res.status).toBe(403);
});

test('CSRF guard admits cookie-auth POST from a trusted origin', async () => {
	const app = createCsrfTestApp();
	const res = await app.request('/api/billing/upgrade', {
		method: 'POST',
		headers: {
			cookie: 'better-auth.session_token=abc123',
			origin: PORTAL_ORIGIN,
			'content-type': 'application/json',
		},
		body: '{}',
	});
	expect(res.status).toBe(200);
});

test('CSRF guard admits bearer-auth POST without an Origin header', async () => {
	const app = createCsrfTestApp();
	const res = await app.request('/api/billing/upgrade', {
		method: 'POST',
		headers: {
			authorization: 'Bearer not-a-real-token-but-bearer-shape',
			'content-type': 'application/json',
		},
		body: '{}',
	});
	expect(res.status).toBe(200);
});

test('CSRF guard admits GET regardless of origin', async () => {
	const app = createCsrfTestApp();
	const res = await app.request('/api/billing/balance', {
		method: 'GET',
		headers: { origin: 'https://evil.example' },
	});
	expect(res.status).toBe(200);
});

function createCsrfTestApp() {
	const app = new Hono();
	app.use('/api/*', requireOriginForCookieMutations);
	app.all('/api/billing/*', (c) => c.json({ ok: true }));
	return app;
}

function createCookieAuthTestServer() {
	const db = createOAuthTestDb();

	for (let attempt = 0; attempt < 40; attempt += 1) {
		const port = nextPort++;
		const baseURL = `http://localhost:${port}`;
		const auth = betterAuth({
			database: memoryAdapter(db),
			emailAndPassword: { enabled: true },
			basePath: '/auth',
			baseURL,
			secret: 'test-secret-test-secret-test-secret',
			trustedOrigins: [baseURL, PORTAL_ORIGIN],
		});

		try {
			const server = Bun.serve({
				port,
				fetch: async (request) => auth.handler(request),
			});
			return { auth, baseURL, db, server };
		} catch (error) {
			if (isAddressInUse(error)) continue;
			throw error;
		}
	}

	throw new Error('Failed to find an available cookie-auth test port.');
}
