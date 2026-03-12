/**
 * CLI-only config for Better Auth schema tools.
 *
 * Run via:
 *   bun run auth:generate  — generate Drizzle schema from Better Auth tables
 *
 * Loads `.dev.vars` via `tooling/env.ts`.
 */

import { fileURLToPath } from 'node:url';
import { oauthProvider } from '@better-auth/oauth-provider';
import { type } from 'arktype';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import { deviceAuthorization } from 'better-auth/plugins/device-authorization';
import { jwt } from 'better-auth/plugins/jwt';
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
	baseURL: 'http://localhost:8787',
	database: drizzleAdapter(db, { provider: 'pg' }),
	secret: env.BETTER_AUTH_SECRET,
	plugins: [
		bearer(),
		jwt(),
		deviceAuthorization(),
		oauthProvider({ loginPage: '/sign-in', consentPage: '/consent' }),
	],
});
