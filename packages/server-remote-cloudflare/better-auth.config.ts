/**
 * CLI-only config for Better Auth schema tools.
 *
 * Run via:
 *   bun run auth:generate  — generate Drizzle schema from Better Auth tables
 *
 * Loads `.dev.vars` via `tooling/env.ts`.
 */

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from './tooling/env';

const sql = postgres(env.DATABASE_URL);
const db = drizzle(sql);

export const auth = betterAuth({
	basePath: '/auth',
	emailAndPassword: { enabled: true },
	database: drizzleAdapter(db, { provider: 'pg' }),
	secret: env.BETTER_AUTH_SECRET,
});
