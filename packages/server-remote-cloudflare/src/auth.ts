import { env } from 'cloudflare:workers';
import { baseAuthConfig } from '@epicenter/server-remote';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './db/schema';

let cached: ReturnType<typeof betterAuth> | null = null;

/** Lazy singleton — deferred to request time to avoid global-scope I/O. */
export function getAuth() {
	if (cached) return cached;

	const sql = postgres(env.HYPERDRIVE.connectionString);
	const db = drizzle(sql, { schema });

	cached = betterAuth({
		...baseAuthConfig,
		database: drizzleAdapter(db, { provider: 'pg' }),
		baseURL: env.BETTER_AUTH_URL,
		secret: env.BETTER_AUTH_SECRET,
		session: {
			expiresIn: 60 * 60 * 24 * 7, // 7 days
			updateAge: 60 * 60 * 24, // 1 day
			storeSessionInDatabase: true,
			cookieCache: {
				enabled: true,
				maxAge: 60 * 5,
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
			'tauri://localhost',
		],
		secondaryStorage: {
			get: (key: string) => env.SESSION_KV.get(key),
			set: (key: string, value: string, ttl?: number) =>
				env.SESSION_KV.put(key, value, {
					expirationTtl: ttl ?? 60 * 5,
				}),
			delete: (key: string) => env.SESSION_KV.delete(key),
		},
	});

	return cached;
}
