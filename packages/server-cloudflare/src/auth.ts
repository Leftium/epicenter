import { env } from 'cloudflare:workers';
import { neon } from '@neondatabase/serverless';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import { jwt } from 'better-auth/plugins/jwt';
import { oauthProvider } from '@better-auth/oauth-provider';
import { drizzle } from 'drizzle-orm/neon-http';

const sql = neon(env.DATABASE_URL);
const db = drizzle(sql);

/** Module-level singleton — safe because `betterAuth()` defers all I/O to request time. */
export const auth = betterAuth({
	basePath: '/auth',
	emailAndPassword: { enabled: true },
	plugins: [
		bearer(),
		jwt(),
		oauthProvider({
			loginPage: '/sign-in',
			consentPage: '/consent',
			requirePKCE: true,
			allowDynamicClientRegistration: true,
			trustedClients: [
				{
					clientId: 'epicenter-desktop',
					name: 'Epicenter Desktop',
					type: 'native',
					redirectUrls: ['tauri://localhost/auth/callback'],
					skipConsent: true,
					metadata: {},
				},
				{
					clientId: 'epicenter-mobile',
					name: 'Epicenter Mobile',
					type: 'native',
					redirectUrls: ['epicenter://auth/callback'],
					skipConsent: true,
					metadata: {},
				},
			],
		}),
	],
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
