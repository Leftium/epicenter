/**
 * Platform Selection Tests
 *
 * Bundles the `#platform/folder` seam the way each build resolves it, with
 * the conditions and aliases `vite.config.ts` declares, and reads every module
 * the bundle pulls in. A dropped leaf or alias fails no build: resolution
 * falls back silently, so the selection is proved here.
 *
 * Key behaviors:
 * - The seam declares the Epicenter host leaf and the browser default
 * - The host build reaches the desktop adapter and its generated bindings,
 *   and no IndexedDB storage, directory opener, or Git implementation
 * - The browser build reaches IndexedDB storage and isomorphic-git, and no
 *   desktop adapter or generated bindings
 * - Neither build reaches the automatic entry, which loads either adapter,
 *   or `@epicenter/app`
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

/** Every module a build of `entry` pulls in, as paths. Built in its own process. */
async function inputs(
	entry: string,
	build: 'browser' | 'epicenter-host',
): Promise<string[]> {
	const child = Bun.spawn(
		[
			process.execPath,
			join(appDir, 'scripts', 'module-graph.ts'),
			entry,
			build,
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

const SEAM_ENTRY = 'src/lib/platform-selection.test-support.ts';

/** Modules of `@epicenter/folder`, by their path below its `src/`. */
const folderModule = (name: string) => (path: string) =>
	path.endsWith(`packages/folder/src/${name}`);

/** The automatic entry, which can load either adapter, and anything of App's. */
const SHARED_FORBIDDEN = /packages\/folder\/src\/index\.ts$|packages\/app\//;

describe('#platform/folder', () => {
	test('declares the Epicenter host leaf and the browser default', () => {
		expect(manifest.imports['#platform/folder']).toEqual({
			'epicenter-host': './src/lib/platform/folder.epicenter-host.ts',
			default: './src/lib/platform/folder.browser.ts',
		});
	});

	test('depends on the folder package and not on App', () => {
		expect(manifest.dependencies['@epicenter/folder']).toBe('workspace:*');
		expect(manifest.dependencies['@epicenter/app']).toBeUndefined();
	});

	test('the host build resolves the desktop adapter without IndexedDB, a directory opener, or a Git implementation', async () => {
		const modules = await inputs(SEAM_ENTRY, 'epicenter-host');

		expect(
			modules.some((path) =>
				path.endsWith('platform/folder.epicenter-host.ts'),
			),
		).toBe(true);
		expect(modules.some(folderModule('tauri.ts'))).toBe(true);
		expect(modules.some(folderModule('tauri-adapter.ts'))).toBe(true);
		expect(modules.some(folderModule('native/bindings.gen.ts'))).toBe(true);
		expect(
			modules.filter(
				(path) =>
					SHARED_FORBIDDEN.test(path) ||
					/platform\/folder\.browser\.ts$|packages\/folder\/src\/(browser|browser-adapter|browser-store|buffer-global|bun|native-store)\.ts$|packages\/folder\/src\/git\/(browser-backend|browser-fs|http|history|native-backend|native-checkpoint|runner)\.ts$|isomorphic-git|fake-indexeddb|^node:|^bun:/.test(
						path,
					),
			),
		).toEqual([]);
	});

	test('the browser build resolves the IndexedDB adapter without the desktop adapter or its bindings', async () => {
		const modules = await inputs(SEAM_ENTRY, 'browser');

		expect(
			modules.some((path) => path.endsWith('platform/folder.browser.ts')),
		).toBe(true);
		expect(modules.some(folderModule('browser.ts'))).toBe(true);
		expect(modules.some(folderModule('browser-adapter.ts'))).toBe(true);
		expect(modules.some(folderModule('browser-store.ts'))).toBe(true);
		expect(modules.some((path) => path.includes('isomorphic-git'))).toBe(true);
		expect(
			modules.filter(
				(path) =>
					SHARED_FORBIDDEN.test(path) ||
					/platform\/folder\.epicenter-host\.ts$|packages\/folder\/src\/(tauri|tauri-adapter|bun|native-store)\.ts$|packages\/folder\/src\/native\/|packages\/folder\/src\/git\/(native-backend|native-checkpoint)\.ts$|tauri-plugin-epicenter-folder|^bun:/.test(
						path,
					),
			),
		).toEqual([]);
	});
});
