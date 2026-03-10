import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';
import { LOCAL_DATABASE_URL } from './tooling/env';

config({ path: fileURLToPath(new URL('.dev.vars', import.meta.url)) });

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/db/schema.ts',
	out: './drizzle',
	dbCredentials: {
		url: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL,
	},
});
