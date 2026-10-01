#!/usr/bin/env bun
/**
 * Print every module that reaches a bundle of one entry, as a JSON array.
 *
 *   bun scripts/module-graph.ts <entry> <browser|bun> [condition...]
 *
 * A module counts when some of its code is in the output. One that is only
 * reachable through an export nothing uses, and is shaken out, does not: the
 * folder package's automatic opener can load either adapter, and a leaf that
 * names one entry must not carry the other.
 *
 * `platform-selection.test.ts` runs this in its own process and reads the
 * list to prove which leaf a build selects and what that leaf can reach.
 */
import { join } from 'node:path';

const appDir = join(import.meta.dir, '..');
const [entry, target, ...conditions] = process.argv.slice(2);
if (entry === undefined || (target !== 'browser' && target !== 'bun')) {
	console.error(
		'Usage: bun scripts/module-graph.ts <entry> <browser|bun> [condition...]',
	);
	process.exit(2);
}

const built = await Bun.build({
	entrypoints: [join(appDir, entry)],
	target,
	conditions,
	// A folder can lazily load a terminal, which Capture never opens.
	// Its shell's browser bundle imports gzip helpers Bun's browser target
	// cannot resolve; the modules that reach it are still listed.
	external: ['just-bash'],
	metafile: true,
});
if (!built.success) {
	for (const log of built.logs) console.error(log);
	process.exit(1);
}
const reached = new Set<string>();
for (const output of Object.values(built.metafile!.outputs))
	for (const [path, input] of Object.entries(output.inputs))
		if (input.bytesInOutput > 0) reached.add(path);
console.log(JSON.stringify([...reached]));
