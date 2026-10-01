#!/usr/bin/env bun
/** Compile the Bun folder host where Tauri expects its external binary. */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { $ } from 'bun';

const appDir = join(import.meta.dir, '..');

const verbose = await $`rustc -vV`.text();
const hostTriple = verbose
	.split('\n')
	.find((line) => line.startsWith('host: '))
	?.slice('host: '.length)
	.trim();
if (!hostTriple) throw new Error('Could not read the host triple from rustc.');

const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple;
if (targetTriple !== hostTriple)
	throw new Error(
		`The Bun compiler cannot produce ${targetTriple} from ${hostTriple}; build each architecture on its matching host.`,
	);

const outfile = join(
	appDir,
	'src-tauri',
	'binaries',
	`honeycrisp-host-${targetTriple}`,
);
await mkdir(dirname(outfile), { recursive: true });
console.error(`Compiling the Honeycrisp folder host -> ${outfile}`);
await $`bun build --compile --outfile ${outfile} ${join(appDir, 'host', 'main.ts')}`;
