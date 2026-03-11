/**
 * CLI-only config for Better Auth schema tools.
 *
 * Run via:
 *   bun run auth:generate  — generate Drizzle schema from Better Auth tables
 *
 * Loads `.dev.vars` via `tooling/env.ts`.
 */

import { fileURLToPath } from 'node:url';
import { type } from 'arktype';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { BASE_AUTH_CONFIG } from './src/app';
import { LOCAL_DATABASE_URL } from './tooling/env';

config({ path: fileURLToPath(new URL('.dev.vars', import.meta.url)) });
const env = type({
	BETTER_AUTH_SECRET: 'string',
	'DATABASE_URL?': 'string',
}).assert(process.env);

const sql = postgres(env.DATABASE_URL ?? LOCAL_DATABASE_URL);
const db = drizzle(sql);

export const auth = betterAuth({
	...BASE_AUTH_CONFIG,
	database: drizzleAdapter(db, { provider: 'pg' }),
	secret: env.BETTER_AUTH_SECRET,
});
