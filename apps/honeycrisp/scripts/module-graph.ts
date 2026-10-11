#!/usr/bin/env bun
/** Print the modules Vite emits for one entry using this app's resolution config. */
import { join } from 'node:path';
import { build } from 'vite';

const appDir = join(import.meta.dir, '..');
const [entry, platform] = process.argv.slice(2);
if (entry === undefined || (platform !== 'browser' && platform !== 'tauri'))
	throw new Error('Usage: bun scripts/module-graph.ts <entry> <browser|tauri>');

if (platform === 'tauri') process.env.HONEYCRISP_DESKTOP = '1';
else delete process.env.HONEYCRISP_DESKTOP;
const { default: config } = await import('../vite.config.js');
const result = await build({
	root: appDir,
	configFile: false,
	logLevel: 'silent',
	resolve: config.resolve,
	build: {
		write: false,
		minify: false,
		target: 'esnext',
		rollupOptions: {
			input: join(appDir, entry),
			preserveEntrySignatures: 'strict',
		},
	},
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap((built) =>
	'output' in built ? built.output : [],
);
console.log(
	JSON.stringify([
		...new Set(
			outputs.flatMap((chunk) =>
				chunk.type === 'chunk' ? Object.keys(chunk.modules) : [],
			),
		),
	]),
);
