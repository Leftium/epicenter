import { oauthProvider } from '@better-auth/oauth-provider';
import { betterAuth } from 'better-auth';
import { bearer, jwt } from 'better-auth/plugins';

type AuthEnv = {
	DATABASE_URL: string;
	SESSION_KV: KVNamespace;
	AUTH_SECRET: string;
	BASE_URL?: string; // e.g. https://api.epicenter.so — needed for OAuth issuer
};

// Module-level cache. Cloudflare Workers reuse isolates across requests,
// so this avoids re-creating the auth instance on every request.
let cached: { auth: ReturnType<typeof betterAuth>; cacheKey: string } | null =
	null;

export function createAuth(env: AuthEnv) {
	if (cached && cached.cacheKey === env.DATABASE_URL) return cached.auth;

	const auth = betterAuth({
		database: {
			type: 'postgres',
			url: env.DATABASE_URL,
		},
		baseURL: env.BASE_URL,
		basePath: '/auth',
		secret: env.AUTH_SECRET,
		emailAndPassword: { enabled: true },
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
		plugins: [
			bearer(),
			jwt(),
			oauthProvider({
				loginPage: '/sign-in',
				consentPage: '/consent',
				requirePKCE: true,
				allowDynamicClientRegistration: true,
			}),
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

	cached = { auth, cacheKey: env.DATABASE_URL };
	return auth;
}
