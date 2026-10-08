import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';
import { LOCAL_DATABASE_URL } from './wrangler-config';

const databaseUrl = new URL(process.env.DATABASE_URL ?? LOCAL_DATABASE_URL);
if (databaseUrl.hostname.endsWith('.supabase.com')) {
	databaseUrl.searchParams.set('sslmode', 'verify-full');
	databaseUrl.searchParams.set(
		'sslrootcert',
		fileURLToPath(new URL('./supabase-ca.crt', import.meta.url)),
	);
}

export default defineConfig({
	dialect: 'postgresql',
	schema: '../../packages/server/src/db/schema/index.ts',
	out: './drizzle',
	dbCredentials: {
		url: databaseUrl.toString(),
	},
});
