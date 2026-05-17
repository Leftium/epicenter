/**
 * Resolve the Epicenter API base URL and the matching on-disk auth token
 * path for the current CLI invocation.
 *
 * The base URL is read from `process.env.EPICENTER_API_URL`, falling back
 * to the embedded `EPICENTER_API_URL` prod constant. The env var, when set,
 * is logged once per process to stderr so operators can see which target
 * the CLI is talking to.
 *
 * Each base URL owns its own token file: the prod host writes to the
 * canonical `~/.epicenter/auth.json` (backwards compatible), and every
 * other host writes to `~/.epicenter/auth.<host>.json`. This isolates the
 * prod cell from local-API logins and prevents the same-subject guard in
 * `createOAuthAppAuth` from wiping prod tokens on an environment switch.
 *
 * See `specs/20260517T212330-cli-api-base-url-configuration.md`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { EPICENTER_API_URL } from '@epicenter/constants/apps';

const PROD_HOST = new URL(EPICENTER_API_URL).host;

let hasLoggedResolvedUrl = false;

/**
 * Read `process.env.EPICENTER_API_URL`, falling back to the prod constant,
 * validate it, and return both the canonical base URL and the per-host auth
 * token file path. Every caller wants both, so they are computed in one pass
 * with a single URL parse.
 *
 * Side effect: when the env var is set (truthy), prints `Using API at <url>.`
 * to stderr on the first call per process. Subsequent calls in the same
 * process are silent. Silent when the env var is unset.
 *
 * @throws Error naming the offending value if the env var is not a valid URL.
 */
export function resolveApiEndpoint(): { baseURL: string; filePath: string } {
	const fromEnv = process.env.EPICENTER_API_URL;
	const raw = (fromEnv ?? EPICENTER_API_URL).replace(/\/$/, '');
	if (!URL.canParse(raw)) {
		throw new Error(`EPICENTER_API_URL is not a valid URL: ${raw}`);
	}
	if (fromEnv && !hasLoggedResolvedUrl) {
		process.stderr.write(`Using API at ${raw}.\n`);
		hasLoggedResolvedUrl = true;
	}
	const { host } = new URL(raw);
	const slug =
		host === PROD_HOST ? 'auth.json' : `auth.${host.replace(':', '_')}.json`;
	return {
		baseURL: raw,
		filePath: join(homedir(), '.epicenter', slug),
	};
}

/**
 * Test-only: reset the module-level "already logged" flag so each test can
 * assert the first-call stderr emission independently. Do not call this
 * from production code.
 */
export function __resetApiUrlLogStateForTests(): void {
	hasLoggedResolvedUrl = false;
}
