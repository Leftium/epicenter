/**
 * CLI-only config for Better Auth schema tools.
 *
 * Run via:
 *   bun run auth:generate  — generate Drizzle schema from Better Auth tables
 *
 * Loads `.dev.vars` via `env.ts`.
 * Schema-affecting options (basePath, plugins, emailAndPassword) come from
 * the shared `better-auth-base` — the single source of truth.
 */

import { baseAuthConfig } from '@epicenter/server-remote';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from './src/env';

const sql = postgres(env.DATABASE_URL);
const db = drizzle(sql);

export const auth = betterAuth({
	...baseAuthConfig,
	database: drizzleAdapter(db, { provider: 'pg' }),
	secret: env.BETTER_AUTH_SECRET,
});
