import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { APPS, localUrl } from '@epicenter/constants/apps';

const apiRoot = resolve(import.meta.dir, '..');
const dashboardBuild = resolve(apiRoot, 'ui/build/dashboard');
const devVars = resolve(apiRoot, '.dev.vars');

// The dashboard SPA is built into apps/api/ui/build/dashboard/ (SvelteKit
// adapter-static + paths.base='/dashboard'). Wrangler errors if its assets
// directory does not exist, even when the dashboard has not been built yet.
await Bun.$`mkdir -p ${dashboardBuild}`;

// Wrangler ignores CLOUDFLARE_INCLUDE_PROCESS_ENV when a .dev.vars file exists,
// so remove any stale copy before piping secrets through process.env. rm with
// force only swallows ENOENT; real failures (permissions, busy file) propagate.
await rm(devVars, { force: true });

const auth = await Bun.$`infisical --silent user get token --plain`
	.quiet()
	.nothrow();

if (auth.exitCode !== 0 || !auth.stdout.toString().trim()) {
	console.error('Not logged into Infisical.');
	console.error(
		'Running `apps/api` requires Infisical access for dev secrets (API keys, auth secret).',
	);
	console.error('Run `infisical login`, then rerun the same command.');
	console.error(
		'If you do not have Infisical access, see CONTRIBUTING.md for what you can work on without it.',
	);
	process.exit(1);
}

const wrangler =
	await Bun.$`infisical run --silent --env=dev --path=/api -- wrangler dev`
		.cwd(apiRoot)
		// API_PUBLIC_ORIGIN is the canonical auth origin (Better Auth baseURL,
		// OAuth issuer, token audience). Production bakes PRODUCTION_API_URL in
		// worker/index.ts; dev overrides it to localhost here so signed cookies
		// and the issuer match the host the browser hits. The value is derived
		// from the same APPS source of truth the dashboard proxy and OAuth seed
		// read, so the port can never drift. CLOUDFLARE_INCLUDE_PROCESS_ENV lifts
		// it (and the Infisical dev secrets) onto the worker's `c.env`.
		.env({
			...Bun.env,
			CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
			API_PUBLIC_ORIGIN: localUrl(APPS.API),
		})
		.nothrow();

process.exit(wrangler.exitCode);
