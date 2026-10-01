/**
 * Platform Selection Tests
 *
 * A dropped seam leaf fails no build: resolution falls back to `default` and
 * the desktop page quietly opens a browser folder. These tests read the
 * declarations and the bundles and name what broke.
 *
 * Key behaviors:
 * - `#platform/notes-host` declares a desktop leaf and a browser default
 * - Neither page bundle contains a Yjs, Node, or Bun module
 * - The desktop page reaches its folder through the shell's folder owner
 *   only: no browser folder store and no Git implementation in the page
 * - No source or configuration still refers to the Bun folder host
 */
import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const appDir = join(import.meta.dir, '..', '..');
const manifest = JSON.parse(
	await readFile(join(appDir, 'package.json'), 'utf8'),
) as {
	imports: Record<string, Record<string, string>>;
	dependencies: Record<string, string>;
	scripts: Record<string, string>;
};

/** Every module a bundle of `entry` pulls in, as paths. Built in its own process. */
async function inputs(
	entry: string,
	options: { conditions?: string[] } = {},
): Promise<string[]> {
	const child = Bun.spawn(
		[
			process.execPath,
			join(appDir, 'scripts', 'module-graph.ts'),
			entry,
			...(options.conditions ?? []),
		],
		{ cwd: appDir, stdout: 'pipe', stderr: 'pipe' },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`Bundling ${entry} failed:\n${stderr}`);
	return JSON.parse(stdout) as string[];
}

const YJS = /(^|\/)(@y\/|yjs\/|y-prosemirror\/|y-protocols\/)/;
/** A Node or Bun built-in, or the directory folder that runs on them. */
const NODE =
	/^(node|bun):|folder\/src\/(bun|native-store)\.ts$|git\/native-backend\.ts$/;

describe('#platform/notes-host', () => {
	test('declares the desktop leaf and the browser default', () => {
		expect(manifest.imports['#platform/notes-host']).toEqual({
			tauri: './src/lib/platform/notes-host.tauri.ts',
			default: './src/lib/platform/notes-host.browser.ts',
		});
	});

	test('the manifest depends on no Yjs package', () => {
		expect(
			Object.keys(manifest.dependencies).filter((name) =>
				/^@y\/|^yjs$|^y-/.test(name),
			),
		).toEqual([]);
	});
});

describe('bundles', () => {
	test('the desktop page reaches its folder through the shell only', async () => {
		const modules = await inputs('src/lib/platform/notes-host.tauri.ts', {
			conditions: ['tauri'],
		});
		expect(modules.filter((path) => YJS.test(path))).toEqual([]);
		expect(modules.filter((path) => NODE.test(path))).toEqual([]);
		expect(
			modules.some((path) => path.endsWith('folder/src/tauri-adapter.ts')),
		).toBe(true);
		expect(
			modules.some((path) => path.endsWith('platform/shell.tauri.ts')),
		).toBe(true);
		// One set of bindings: the ones the folder package generated.
		expect(
			modules
				.filter((path) => path.endsWith('bindings.gen.ts'))
				.map((path) => path.slice(path.indexOf('packages/'))),
		).toEqual(['packages/folder/src/native/bindings.gen.ts']);
		// The folder contract came through the desktop entry, not the selector.
		expect(
			modules.filter((path) => /folder\/src\/(index|browser)\.ts$/.test(path)),
		).toEqual([]);
		// No second store, and no Git implementation in the page.
		expect(
			modules.filter((path) =>
				/folder\/src\/(browser-adapter|browser-store)\.ts$|folder\/src\/git\/(history|browser-backend)\.ts$/.test(
					path,
				),
			),
		).toEqual([]);
		expect(modules.filter((path) => path.includes('isomorphic-git'))).toEqual(
			[],
		);
	});

	test('the browser page opens a browser folder without Yjs or a native path', async () => {
		const modules = await inputs('src/lib/platform/notes-host.browser.ts', {});
		expect(modules.filter((path) => YJS.test(path))).toEqual([]);
		expect(modules.filter((path) => NODE.test(path))).toEqual([]);
		expect(
			modules.some((path) => path.endsWith('folder/src/browser-store.ts')),
		).toBe(true);
		// No desktop adapter, no bindings, and none of the shell's commands.
		expect(
			modules.filter((path) =>
				/folder\/src\/(index|tauri|tauri-adapter)\.ts$|bindings\.gen\.ts$|platform\/shell\.tauri\.ts$/.test(
					path,
				),
			),
		).toEqual([]);
	});

	test('the editor, the draft, and the note state contain no Yjs module', async () => {
		for (const entry of [
			'src/lib/editor/markdown.ts',
			'src/lib/note-source.ts',
			'src/lib/data.ts',
		]) {
			const modules = await inputs(entry);
			expect(modules.filter((path) => YJS.test(path))).toEqual([]);
		}
	});
});

describe('the Bun folder host is gone', () => {
	/** Source and configuration that ship or build; tests and evidence are not scanned. */
	async function shipped(directory: string): Promise<string[]> {
		const found: string[] = [];
		for (const entry of await readdir(join(appDir, directory), {
			withFileTypes: true,
		})) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!['target', 'gen', 'icons', 'node_modules'].includes(entry.name))
					found.push(...(await shipped(path)));
			} else if (
				/\.(ts|svelte|rs|json|toml|js)$/.test(entry.name) &&
				!/\.test\.ts$/.test(entry.name) &&
				entry.name !== 'tests.rs'
			)
				found.push(path);
		}
		return found;
	}

	test('no shipped source or configuration refers to the host, the bridge, or its token', async () => {
		const files = [
			...(await shipped('src')),
			...(await shipped('src-tauri')),
			...(await shipped('scripts')),
			'package.json',
			'vite.config.ts',
			'svelte.config.js',
			'tsconfig.scripts.json',
		];
		const stale =
			/\/bridge\b|bridge\/|__HONEYCRISP_BRIDGE__|HONEYCRISP_HOST|HONEYCRISP_SHELL|HONEYCRISP_UI_DIST|HONEYCRISP_FAULTS|honeycrisp-host|host\/main|build:host|externalBin|frontend-placeholder|Bearer |127\.0\.0\.1/;
		const offenders: string[] = [];
		for (const file of files) {
			const text = await readFile(join(appDir, file), 'utf8');
			const match = stale.exec(text);
			if (match) offenders.push(`${file}: ${match[0]}`);
		}
		expect(offenders).toEqual([]);
	});

	test('the default test run needs no Rust toolchain', () => {
		expect(manifest.scripts.test).toBe(
			'bun test --isolate --conditions=browser ./src',
		);
		expect(manifest.scripts['test:native']).toContain('cargo test');
	});
});
