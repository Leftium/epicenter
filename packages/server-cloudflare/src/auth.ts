import { env } from 'cloudflare:workers';
import { neon } from '@neondatabase/serverless';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/neon-http';
import { baseAuthConfig } from './auth-base';
import * as schema from './db/schema';
import { factory } from './hono';

const sql = neon(env.DATABASE_URL);
const db = drizzle(sql, { schema });

/** Module-level singleton — safe because `betterAuth()` defers all I/O to request time. */
export const auth = betterAuth({
	...baseAuthConfig,
	database: drizzleAdapter(db, { provider: 'pg' }),
	baseURL: env.BETTER_AUTH_URL,
	secret: env.BETTER_AUTH_SECRET,
	session: {
		expiresIn: 60 * 60 * 24 * 7, // 7 days
		updateAge: 60 * 60 * 24, // 1 day
		// When secondaryStorage is set, Better Auth stores sessions there
		// INSTEAD of the DB by default. Explicitly opt in to DB persistence
		// so Neon acts as the authoritative fallback during KV's ~60s
		// eventual-consistency propagation window (multi-device scenario).
		storeSessionInDatabase: true,
		cookieCache: {
			enabled: true,
			maxAge: 60 * 5, // 5 min — browser clients skip DB/KV entirely
			// JWE encrypts the session payload in the cookie. Signed-only
			// strategies (jwt, compact) leak readable session data.
			strategy: 'jwe',
		},
	},
	advanced: {
		crossSubDomainCookies: {
			enabled: true,
			domain: 'epicenter.so',
		},
	},
	trustedOrigins: [
		'https://*.epicenter.so',
		'https://epicenter.so',
		'tauri://localhost', // Tauri desktop app
	],
	// Cloudflare KV as secondary storage for session caching.
	// Bearer-token clients (mobile, Tauri) can't use cookieCache, so KV
	// handles their session lookups at the edge (~5ms) instead of hitting
	// Neon (~50-100ms). Browser clients benefit from cookieCache (zero
	// lookup) with KV as fallback when the cookie expires.
	secondaryStorage: {
		get: (key) => env.SESSION_KV.get(key),
		set: (key, value, ttl) =>
			env.SESSION_KV.put(key, value, {
				expirationTtl: ttl ?? 60 * 5, // default 5 min
			}),
		delete: (key) => env.SESSION_KV.delete(key),
	},
});

export function createAuthMiddleware() {
	return factory.createMiddleware(async (c, next) => {
		// WebSocket clients pass the token as a query param (no Authorization
		// header on upgrade requests). Normalise into a Bearer header so
		// Better Auth's bearer() plugin handles extraction uniformly.
		const wsToken = c.req.query('token');
		const headers = wsToken
			? new Headers({ authorization: `Bearer ${wsToken}` })
			: c.req.raw.headers;

		const result = await auth.api.getSession({ headers });
		if (!result) return c.json({ error: 'Unauthorized' }, 401);

		c.set('user', result.user);
		c.set('session', result.session);
		await next();
	});
}
