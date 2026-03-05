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
 * This file spreads {@link authOptions} (from `src/auth/options.ts`) so the
 * CLI schema always matches the runtime worker. Runtime-only options (KV
 * caching, cookies, trusted origins) are omitted — they don't affect the
 * database schema.
 *
 * @see src/auth/server.ts — runtime `createAuth()` factory
 * @see src/auth/options.ts — shared schema-affecting options
 */
import { type } from 'arktype';
import { neon } from '@neondatabase/serverless';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/neon-http';
import { authOptions } from './src/auth/options';

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

export const auth = betterAuth({
	...authOptions,
	database: drizzleAdapter(db, { provider: 'pg' }),
	secret: env.BETTER_AUTH_SECRET,
});
