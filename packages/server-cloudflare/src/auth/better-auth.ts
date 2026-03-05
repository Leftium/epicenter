import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';

type AuthEnv = {
	DATABASE_URL: string;
	SESSION_KV: KVNamespace;
	AUTH_SECRET: string;
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
		basePath: '/auth',
		secret: env.AUTH_SECRET,
		emailAndPassword: { enabled: true },
		session: {
			expiresIn: 60 * 60 * 24 * 7, // 7 days
			updateAge: 60 * 60 * 24, // 1 day
		},
		plugins: [bearer()],
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
