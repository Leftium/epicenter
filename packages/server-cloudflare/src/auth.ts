// CLI-only config for `bunx @better-auth/cli migrate` and `bunx @better-auth/cli generate`.
// Run via: bun run auth:generate or bun run auth:migrate (loads .dev.vars automatically).
// Spreads sharedAuthConfig so the CLI schema always matches the runtime worker.
import { type } from 'arktype';
import { betterAuth } from 'better-auth';
import { sharedAuthConfig } from './auth/server';

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

export const auth = betterAuth({
	...sharedAuthConfig,
	database: {
		type: 'postgres',
		url: env.DATABASE_URL,
	},
	secret: env.BETTER_AUTH_SECRET,
});
