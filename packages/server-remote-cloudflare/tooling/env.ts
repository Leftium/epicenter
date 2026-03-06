/**
 * Validated env for CLI scripts (drizzle-kit, better-auth CLI).
 *
 * Loads `.dev.vars` for secrets and derives `DATABASE_URL` from
 * `wrangler.jsonc`'s Hyperdrive `localConnectionString`.
 *
 * **Why derive from wrangler.jsonc?**
 * `localConnectionString` is Hyperdrive's local-dev-only substitute — in
 * production, the real connection string lives in Cloudflare's Hyperdrive
 * service and the worker reads it via `env.HYPERDRIVE.connectionString`.
 * CLI tools (drizzle-kit, better-auth) can't use Hyperdrive bindings, so
 * they need a direct URL. Rather than duplicating it in `.dev.vars`, we
 * read it straight from `wrangler.jsonc` — the single source of truth.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type } from 'arktype';
import { config } from 'dotenv';
import { parse as parseJSONC } from 'jsonc-parser';

config({ path: fileURLToPath(new URL('../.dev.vars', import.meta.url)) });

const HyperdriveEntry = type({ localConnectionString: 'string' });

const WranglerConfig = type('string')
	.pipe((s) => parseJSONC(s) as Record<string, unknown>)
	.to({
		hyperdrive: [HyperdriveEntry, '...', HyperdriveEntry.array()],
	});

const jsoncString = readFileSync(
	fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
	'utf-8',
);

const wranglerConfig = WranglerConfig.assert(jsoncString);
const DATABASE_URL = wranglerConfig.hyperdrive[0].localConnectionString;

const { BETTER_AUTH_SECRET } = type({ BETTER_AUTH_SECRET: 'string' }).assert(
	process.env,
);

export const env = { BETTER_AUTH_SECRET, DATABASE_URL };
