import { oauthProvider } from '@better-auth/oauth-provider';
import type { Auth } from 'better-auth';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import { jwt } from 'better-auth/plugins/jwt';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './db/schema';

/** Auth instance with oauth-provider plugin APIs preserved. */
type AuthWithOAuth = Auth & {
	api: {
		getOpenIdConfig: (...args: unknown[]) => unknown;
		getOAuthServerConfig: (...args: unknown[]) => unknown;
	};
};

const trustedClients = [
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
] as const;

/** Creates a fresh auth instance per-request. Hyperdrive clients must not be cached across requests. */
export function createAuth(env: Cloudflare.Env): AuthWithOAuth {
	const sql = postgres(env.HYPERDRIVE.connectionString);
	const db = drizzle(sql, { schema });

	return betterAuth({
		basePath: '/auth',
		emailAndPassword: { enabled: true },
		database: drizzleAdapter(db, { provider: 'pg' }),
		baseURL: env.BETTER_AUTH_URL,
		secret: env.BETTER_AUTH_SECRET,
		plugins: [
			bearer(),
			jwt(),
			oauthProvider({
				loginPage: '/sign-in',
				consentPage: '/consent',
				requirePKCE: true,
				allowDynamicClientRegistration: true,
				trustedClients: [...trustedClients],
			}),
		],
		session: {
			expiresIn: 60 * 60 * 24 * 7,
			updateAge: 60 * 60 * 24,
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
	}) as unknown as AuthWithOAuth;
}
