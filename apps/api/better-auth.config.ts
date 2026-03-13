/**
 * CLI-only config for Better Auth schema tools.
 *
 * This file exists solely for `@better-auth/cli generate` to introspect the auth
 * config and emit the correct Drizzle schema. It is never used at runtime—the
 * Cloudflare Worker uses `createAuth()` in `src/app.ts` instead.
 *
 * Both configs spread `BASE_AUTH_CONFIG` (which owns the plugin list) so the CLI
 * and runtime always agree on which tables exist.
 *
 * Run via:
 *   bun run auth:generate
 *
 * Env strategy:
 *   - `BETTER_AUTH_SECRET` comes from `.dev.vars` (loaded via dotenv) or Infisical.
 *   - `DATABASE_URL` falls back to the local Postgres URL parsed from `wrangler.jsonc`
 *     by `env.ts`.
 */

import { fileURLToPath } from 'node:url';
import { createApps } from '@epicenter/constants/apps';
import { type } from 'arktype';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { BASE_AUTH_CONFIG } from './src/app';
import { LOCAL_DATABASE_URL } from './env';

config({ path: fileURLToPath(new URL('.dev.vars', import.meta.url)) });
const env = type({
	BETTER_AUTH_SECRET: 'string',
	'DATABASE_URL?': 'string',
}).assert(process.env);

const sql = postgres(env.DATABASE_URL ?? LOCAL_DATABASE_URL);
const db = drizzle(sql);

export const auth = betterAuth({
	...BASE_AUTH_CONFIG,
	/**
	 * The CLI always runs locally, so we hardcode the dev URL. The value doesn't
	 * affect schema generation—it only prevents `oauthProvider` from crashing on
	 * `new URL('')` during plugin init. The runtime config uses `env.BASE_URL` instead.
	 */
	baseURL: createApps('development').API.URL,
	database: drizzleAdapter(db, { provider: 'pg' }),
	secret: env.BETTER_AUTH_SECRET,
});
