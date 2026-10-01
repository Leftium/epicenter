#!/usr/bin/env bun
/**
 * Print every module a bundle of one entry pulls in, as a JSON array.
 *
 *   bun scripts/module-graph.ts <entry> <browser|bun> [condition...]
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
	metafile: true,
});
if (!built.success) {
	for (const log of built.logs) console.error(log);
	process.exit(1);
}
console.log(JSON.stringify(Object.keys(built.metafile!.inputs)));
