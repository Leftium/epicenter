// CLI-only config for `npx @better-auth/cli migrate` and `npx @better-auth/cli generate`.
// Reads DATABASE_URL from .env / environment — no Cloudflare bindings needed.
// The plugin list is shared with the runtime auth instance so the schema stays in sync.
import { betterAuth } from 'better-auth';
import { authPlugins } from './src/auth/better-auth';

export const auth = betterAuth({
	database: {
		type: 'postgres',
		url: process.env.DATABASE_URL!,
	},
	basePath: '/auth',
	secret: process.env.BETTER_AUTH_SECRET ?? 'cli-migrate-placeholder',
	emailAndPassword: { enabled: true },
	plugins: [...authPlugins],
});
