/**
 * CLI-only config for Better Auth schema tools.
 *
 * Run via:
 *   bun run auth:generate  — generate Drizzle schema from Better Auth tables
 *
 * Loads `.dev.vars` via `src/cli-env.ts`.
 * Schema-affecting options (basePath, plugins, emailAndPassword) come from
 * `src/auth-base.ts` — the single source of truth.
 */

import { neon } from '@neondatabase/serverless';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/neon-http';
import { authSchemaConfig } from './src/auth-base';
import { cliEnv } from './src/cli-env';

const sql = neon(cliEnv.DATABASE_URL);
const db = drizzle(sql);

export const auth = betterAuth({
	...authSchemaConfig,
	database: drizzleAdapter(db, { provider: 'pg' }),
	secret: cliEnv.BETTER_AUTH_SECRET,
});
