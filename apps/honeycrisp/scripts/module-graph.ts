#!/usr/bin/env bun
/**
 * Print every module a bundle of one entry pulls in, as a JSON array.
 *
 *   bun scripts/module-graph.ts <entry> [condition...]
 *
 * `platform-selection.test.ts` runs this in its own process and reads the
 * list to prove which leaf a build selects and that no Yjs module is in it.
 */
import { join } from 'node:path';

const appDir = join(import.meta.dir, '..');
const [entry, ...conditions] = process.argv.slice(2);
if (entry === undefined) {
	console.error('Usage: bun scripts/module-graph.ts <entry> [condition...]');
	process.exit(2);
}

const built = await Bun.build({
	entrypoints: [join(appDir, entry)],
	target: 'browser',
	conditions,
	metafile: true,
	plugins: [
		{
			name: 'app-aliases',
			setup(build) {
				// What Vite's alias does for the folder contract: the bare
				// specifier is the build's one adapter entry.
				build.onResolve({ filter: /^@epicenter\/folder$/ }, () => ({
					path: Bun.resolveSync(
						conditions.includes('tauri')
							? '@epicenter/folder/tauri'
							: '@epicenter/folder/browser',
						appDir,
					),
				}));
				// What it does for just-bash's unused gzip helpers.
				build.onResolve({ filter: /^node:zlib$/ }, () => ({
					path: join(appDir, 'src/lib/shims/zlib.ts'),
				}));
				// And for isomorphic-git's Buffer: the npm package, not Node's.
				build.onResolve({ filter: /^buffer$/ }, () => ({
					path: Bun.resolveSync('buffer/', appDir),
				}));
			},
		},
	],
});
if (!built.success) {
	for (const log of built.logs) console.error(log);
	process.exit(1);
}
console.log(JSON.stringify(Object.keys(built.metafile!.inputs)));
