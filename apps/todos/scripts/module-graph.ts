#!/usr/bin/env bun
/**
 * Print every module a bundle of one entry pulls in, as a JSON array.
 *
 *   bun scripts/module-graph.ts <entry> <browser|epicenter-host>
 *
 * The entry is resolved the way that build resolves it: with the conditions
 * and aliases `vite.config.ts` declares for it, read from the config itself.
 * `platform-selection.test.ts` runs this in its own process and reads the
 * list to prove which leaf a build selects and what that leaf can reach.
 */
import { join } from 'node:path';
import { type Alias, defaultClientConditions } from 'vite';

const appDir = join(import.meta.dir, '..');
const [entry, build] = process.argv.slice(2);
if (
	entry === undefined ||
	(build !== 'browser' && build !== 'epicenter-host')
) {
	console.error(
		'Usage: bun scripts/module-graph.ts <entry> <browser|epicenter-host>',
	);
	process.exit(2);
}

// The config reads this when it is imported, as `build:epicenter` sets it.
if (build === 'epicenter-host') process.env.EPICENTER_HOST = '1';
else delete process.env.EPICENTER_HOST;
const { default: config } = await import('../vite.config.js');

const declared = config.resolve?.alias ?? [];
const aliases: readonly Alias[] = Array.isArray(declared)
	? declared
	: Object.entries(declared).map(([find, replacement]) => ({
			find,
			replacement,
		}));

/** The specifier an alias rewrites `specifier` to, as Vite applies the first match. */
function aliased(specifier: string): string | undefined {
	for (const { find, replacement } of aliases) {
		if (typeof find !== 'string') {
			if (find.test(specifier)) return specifier.replace(find, replacement);
		} else if (specifier === find || specifier.startsWith(`${find}/`))
			return replacement + specifier.slice(find.length);
	}
	return undefined;
}

const built = await Bun.build({
	entrypoints: [join(appDir, entry)],
	target: 'browser',
	// Vite's own client conditions are Bun's browser defaults already.
	conditions: (config.resolve?.conditions ?? []).filter(
		(condition) => !defaultClientConditions.includes(condition),
	),
	metafile: true,
	plugins: [
		{
			name: 'vite-aliases',
			setup(builder) {
				builder.onResolve({ filter: /./ }, ({ path }) => {
					const target = aliased(path);
					return target === undefined
						? undefined
						: { path: Bun.resolveSync(target, appDir) };
				});
			},
		},
	],
});
if (!built.success) {
	for (const log of built.logs) console.error(log);
	process.exit(1);
}
console.log(JSON.stringify(Object.keys(built.metafile!.inputs)));
