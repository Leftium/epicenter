/**
 * Build the Bun directory folder's file exchange addon (`addon/exchange.c`)
 * to the path `src/native-exchange.ts` loads it from.
 *
 *   bun run build:addon        # in packages/folder
 *   bun run --filter @epicenter/folder build:addon
 *
 * macOS and Linux: compiles with `$CC`, else `cc`, against the
 * `node-api-headers` development dependency. A build already there for this
 * source, platform, and architecture is kept. Concurrent builds each write
 * their own file and rename it into place, so a loader never sees a
 * half-written library. A failed build exits nonzero and names the compiler
 * and its output.
 *
 * Windows and other platforms: there is no addon, and nothing is built; the
 * script says so and exits zero, so their other tests still run. Their
 * replacements are unavailable: refused as `Io`, nothing written (see
 * `native-store.ts`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import {
	EXCHANGE_SOURCE,
	exchangeArtifact,
	exchangeSupported,
} from '../src/native-exchange.js';

if (!exchangeSupported) {
	console.log(
		`No file exchange addon on ${process.platform}; nothing to build.`,
	);
	process.exit(0);
}

const output = exchangeArtifact();
if (existsSync(output)) {
	console.log(output);
	process.exit(0);
}

const { include_dir: include } = createRequire(import.meta.url)(
	'node-api-headers',
) as { include_dir: string };
mkdirSync(dirname(output), { recursive: true });
const staged = `${output}.${process.pid}-${crypto.randomUUID()}`;
const compiler = process.env.CC || 'cc';
const linkage =
	process.platform === 'darwin'
		? ['-bundle', '-undefined', 'dynamic_lookup']
		: ['-shared', '-fPIC'];
const compiled = spawnSync(
	compiler,
	['-O2', '-Wall', `-I${include}`, ...linkage, EXCHANGE_SOURCE, '-o', staged],
	{ encoding: 'utf8' },
);
if (compiled.error !== undefined || compiled.status !== 0) {
	rmSync(staged, { force: true });
	console.error(
		`Could not build the folder's file exchange addon with '${compiler}': ${
			compiled.error?.message ??
			(compiled.stderr.trim() || `exit ${compiled.status}`)
		}`,
	);
	process.exit(1);
}
if (compiled.stderr.trim() !== '') console.error(compiled.stderr.trim());
renameSync(staged, output);
console.log(output);
