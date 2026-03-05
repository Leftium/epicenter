import { betterAuth } from 'better-auth';
import { bearer, jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';

/** Plugins that affect the database schema. Shared between the runtime auth
 *  instance and the CLI config so `npx @better-auth/cli migrate` discovers
 *  the same tables the worker uses. */
export const authPlugins = [
	bearer(),
	jwt(),
	oauthProvider({
		loginPage: '/sign-in',
		consentPage: '/consent',
		requirePKCE: true,
		allowDynamicClientRegistration: true,
	}),
] as const;

type AuthEnv = {
	DATABASE_URL: string;
	SESSION_KV: KVNamespace;
	BETTER_AUTH_SECRET: string;
	BETTER_AUTH_URL?: string; // e.g. https://api.epicenter.so — needed for OAuth issuer
};

export function createAuth(env: AuthEnv) {
	const auth = betterAuth({
		database: {
			type: 'postgres',
			url: env.DATABASE_URL,
		},
		baseURL: env.BETTER_AUTH_URL,
		basePath: '/auth',
		secret: env.BETTER_AUTH_SECRET,
		emailAndPassword: { enabled: true },
		plugins: [...authPlugins],
		databaseHooks: {
			session: {
				delete: {
					after: async (session) => {
						// Write a revocation marker so stale KV caches reject the
						// token during the eventual-consistency window. KV docs say
						// "60 seconds or more", so 5 min gives wide safety margin.
						await env.SESSION_KV.put(
							`revoked:${session.token}`,
							'1',
							{ expirationTtl: 300 },
						);
					},
				},
			},
		},
		session: {
			expiresIn: 60 * 60 * 24 * 7, // 7 days
			updateAge: 60 * 60 * 24, // 1 day
			// Keep storeSessionInDatabase as default (true). Sessions are written
			// to both KV and Neon. This is critical for multi-device users: KV is
			// eventually consistent (~60s propagation), so a user signing in on
			// their phone (edge A) and immediately opening the desktop app (edge B)
			// needs the Neon fallback during the propagation window.
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
			'https://epicenter.so',
			'https://app.epicenter.so',
			'https://api.epicenter.so',
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

	return auth;
}
