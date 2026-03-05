/**
 * Validated env for CLI scripts (drizzle-kit, better-auth CLI).
 *
 * Loads `.dev.vars` and validates with arktype. Import this instead of
 * using `process.env` with non-null assertions.
 */

import { type } from 'arktype';
import { config } from 'dotenv';

config({ path: new URL('.dev.vars', import.meta.url).pathname });

const Env = type({
	DATABASE_URL: 'string',
	BETTER_AUTH_SECRET: 'string',
});

const parsed = Env(process.env);
if (parsed instanceof type.errors) {
	throw new Error(
		`Missing env vars. Ensure .dev.vars has DATABASE_URL and BETTER_AUTH_SECRET.\n${parsed.summary}`,
	);
}

export const env = parsed;
