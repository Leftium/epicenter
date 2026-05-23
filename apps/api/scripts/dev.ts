import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const apiRoot = resolve(import.meta.dir, '..');
const dashboardBuild = resolve(apiRoot, '../dashboard/build/dashboard');
const devVars = resolve(apiRoot, '.dev.vars');

await Bun.$`mkdir -p ${dashboardBuild}`;

// Wrangler ignores CLOUDFLARE_INCLUDE_PROCESS_ENV when a .dev.vars file exists,
// so remove any stale copy before piping secrets through process.env.
await unlink(devVars).catch(() => {});

const auth = await Bun.$`infisical --silent user get token --plain`
	.quiet()
	.nothrow();

if (auth.exitCode !== 0 || !auth.stdout.toString().trim()) {
	console.error('Not logged into Infisical.');
	console.error('Run `infisical login`, then retry `bun run dev:api`.');
	process.exit(1);
}

const wrangler = await Bun.$`infisical run --silent --path=/api -- wrangler dev`
	.cwd(apiRoot)
	.env({ ...Bun.env, CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true' })
	.nothrow();

process.exit(wrangler.exitCode);
