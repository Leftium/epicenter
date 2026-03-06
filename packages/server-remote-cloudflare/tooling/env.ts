/**
 * Validated env for CLI scripts (drizzle-kit, better-auth CLI).
 *
 * Loads `.dev.vars` for secrets and derives `DATABASE_URL` from
 * `wrangler.toml`'s Hyperdrive `localConnectionString`.
 *
 * **Why derive from wrangler.toml?**
 * `localConnectionString` is Hyperdrive's local-dev-only substitute — in
 * production, the real connection string lives in Cloudflare's Hyperdrive
 * service and the worker reads it via `env.HYPERDRIVE.connectionString`.
 * CLI tools (drizzle-kit, better-auth) can't use Hyperdrive bindings, so
 * they need a direct URL. Rather than duplicating it in `.dev.vars`, we
 * read it straight from `wrangler.toml` — the single source of truth.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type } from 'arktype';
import { config } from 'dotenv';
import { parse as parseTOML } from 'smol-toml';

config({ path: fileURLToPath(new URL('../.dev.vars', import.meta.url)) });

const HyperdriveEntry = type({ localConnectionString: 'string' });

const WranglerToml = type('string')
	.pipe((s) => parseTOML(s))
	.to({
		hyperdrive: [HyperdriveEntry, '...', HyperdriveEntry.array()],
	});

const tomlString = readFileSync(
	fileURLToPath(new URL('../wrangler.toml', import.meta.url)),
	'utf-8',
);

const wranglerToml = WranglerToml.assert(tomlString);
const DATABASE_URL = wranglerToml.hyperdrive[0].localConnectionString;

const { BETTER_AUTH_SECRET } = type({ BETTER_AUTH_SECRET: 'string' }).assert(
	process.env,
);

export const env = { BETTER_AUTH_SECRET, DATABASE_URL };
