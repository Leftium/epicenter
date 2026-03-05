// CLI-only config for `npx @better-auth/cli migrate` and `npx @better-auth/cli generate`.
// Reads DATABASE_URL from .env / environment — no Cloudflare bindings needed.
// Spreads sharedAuthConfig so the CLI schema always matches the runtime worker.
import { betterAuth } from 'better-auth';
import { sharedAuthConfig } from './src/auth/better-auth';

export const auth = betterAuth({
	...sharedAuthConfig,
	database: {
		type: 'postgres',
		url: process.env.DATABASE_URL!,
	},
	secret: process.env.BETTER_AUTH_SECRET ?? 'cli-migrate-placeholder',
});
