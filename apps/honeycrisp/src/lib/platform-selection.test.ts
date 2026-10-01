/**
 * Platform Selection Tests
 *
 * A dropped seam leaf fails no build: resolution falls back to `default` and
 * the desktop page quietly opens a browser folder. These tests read the
 * declarations and the bundles and name what broke.
 *
 * Key behaviors:
 * - `#platform/notes-host` declares a desktop leaf and a browser default
 * - Neither page bundle, nor the folder host, contains a Yjs module
 * - The desktop page bundle contains no Node module and no browser folder store
 */
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const appDir = join(import.meta.dir, '..', '..');
const manifest = JSON.parse(
	await readFile(join(appDir, 'package.json'), 'utf8'),
) as {
	imports: Record<string, Record<string, string>>;
	dependencies: Record<string, string>;
};

/** Every module a bundle of `entry` pulls in, as paths. Built in its own process. */
async function inputs(
	entry: string,
	options: { target: 'browser' | 'bun'; conditions?: string[] },
): Promise<string[]> {
	const child = Bun.spawn(
		[
			process.execPath,
			join(appDir, 'scripts', 'module-graph.ts'),
			entry,
			options.target,
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
	test('the desktop page reaches its folder over the bridge only', async () => {
		const modules = await inputs('src/lib/platform/notes-host.tauri.ts', {
			target: 'browser',
			conditions: ['tauri'],
		});
		expect(modules.filter((path) => YJS.test(path))).toEqual([]);
		expect(
			modules.some((path) => path.endsWith('bridge/folder-client.ts')),
		).toBe(true);
		expect(
			modules.filter((path) =>
				/files\/(browser-store|native|native-store)\.ts$/.test(path),
			),
		).toEqual([]);
		expect(modules.filter((path) => path.includes('isomorphic-git'))).toEqual(
			[],
		);
	});

	test('the browser page opens a browser folder without Yjs', async () => {
		const modules = await inputs('src/lib/platform/notes-host.browser.ts', {
			target: 'browser',
		});
		expect(modules.filter((path) => YJS.test(path))).toEqual([]);
		expect(
			modules.some((path) => path.endsWith('files/browser-store.ts')),
		).toBe(true);
		expect(
			modules.filter((path) => /files\/native(-store)?\.ts$/.test(path)),
		).toEqual([]);
	});

	test('the editor, the draft, and the note state contain no Yjs module', async () => {
		for (const entry of [
			'src/lib/editor/markdown.ts',
			'src/lib/note-source.ts',
			'src/lib/data.ts',
		]) {
			const modules = await inputs(entry, { target: 'browser' });
			expect(modules.filter((path) => YJS.test(path))).toEqual([]);
		}
	});

	test('the folder host contains no Yjs module', async () => {
		const modules = await inputs('host/main.ts', { target: 'bun' });
		expect(modules.filter((path) => YJS.test(path))).toEqual([]);
		expect(modules.some((path) => path.endsWith('files/native.ts'))).toBe(true);
	});
});
