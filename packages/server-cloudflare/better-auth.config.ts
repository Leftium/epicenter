/**
 * CLI-only config for Better Auth schema tools.
 *
 * Run via:
 *   bun run auth:generate  — generate migration SQL
 *   bun run auth:migrate   — apply pending migrations
 *   bun run auth:schema    — generate Drizzle schema from Better Auth tables
 *
 * These scripts load `.dev.vars` automatically via `--env-file`.
 *
 * Schema-affecting options (basePath, plugins, emailAndPassword) are duplicated
 * from `src/auth.ts` — keep them in sync. Runtime-only options (KV caching,
 * cookies, trusted origins) are omitted since they don't affect the schema.
 *
 * @see src/auth.ts — runtime singleton (source of truth)
 */
import { type } from 'arktype';
import { neon } from '@neondatabase/serverless';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import { jwt } from 'better-auth/plugins/jwt';
import { oauthProvider } from '@better-auth/oauth-provider';
import { drizzle } from 'drizzle-orm/neon-http';

const CliEnv = type({
	DATABASE_URL: 'string',
	BETTER_AUTH_SECRET: 'string',
});

const env = CliEnv(process.env);
if (env instanceof type.errors) {
	throw new Error(
		`Missing env vars for Better Auth CLI. Run with --env-file=.dev.vars.\n${env.summary}`,
	);
}

const sql = neon(env.DATABASE_URL);
const db = drizzle(sql);

// Keep schema-affecting options in sync with src/auth.ts
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
	secret: env.BETTER_AUTH_SECRET,
});
