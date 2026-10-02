/**
 * Platform Selection Tests
 *
 * A dropped seam leaf fails no build: resolution falls back to `default` and
 * the desktop page quietly opens a browser folder in IndexedDB. These tests
 * bundle through the app's Vite resolution config and name what broke.
 *
 * Key behaviors:
 * - The host leaf opens through the desktop folder adapter only: the browser
 *   leaf, the browser adapter and its IndexedDB store, any Git implementation,
 *   the directory opener, and every Node module are absent from its bundle
 * - The browser leaf carries the browser adapter and no desktop adapter, no
 *   generated native bindings, and no shell quit protocol
 * - Neither folder leaf loads the account recovery store
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const appDir = join(import.meta.dir, '..', '..');
/** Every module that reaches a bundle of `entry`, as paths. Built in its own process. */
async function inputs(
	entry: string,
	platform: 'browser' | 'epicenter-host',
): Promise<string[]> {
	const child = Bun.spawn(
		[
			process.execPath,
			join(appDir, 'scripts', 'module-graph.ts'),
			entry,
			platform,
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

describe('#platform/folder', () => {
	test('the host build opens through the desktop adapter and carries nothing that stores a folder', async () => {
		const modules = await inputs(SEAM_ENTRY, 'epicenter-host');
		for (const required of [
			'platform/folder.epicenter-host.ts',
			'platform/shell-lifetime.ts',
			'folder/src/tauri.ts',
			'folder/src/tauri-adapter.ts',
			'folder/src/native/bindings.gen.ts',
		])
			expect(modules.filter((path) => path.endsWith(required))).toHaveLength(1);
		expect(
			modules.filter((path) =>
				/platform\/folder\.browser\.ts$|folder\/src\/(browser|browser-adapter|browser-store|bun|native-store)\.ts$|folder\/src\/git\/(browser|native)-|isomorphic-git|^node:|^bun:/.test(
					path,
				),
			),
		).toEqual([]);
		expect(
			modules.filter((path) => /legacy\/|open-store\.ts$|@y[+/]/.test(path)),
		).toEqual([]);
	});

	test('the browser build opens through the browser adapter, with no desktop adapter and no shell protocol', async () => {
		const modules = await inputs(SEAM_ENTRY, 'browser');
		for (const required of [
			'platform/folder.browser.ts',
			'folder/src/browser.ts',
			'folder/src/browser-adapter.ts',
			'folder/src/browser-store.ts',
		])
			expect(modules.filter((path) => path.endsWith(required))).toHaveLength(1);
		expect(
			modules.filter((path) =>
				// The browser adapter asks `isTauri()` so it can refuse there; that one
				// module of the Tauri API is its only use of it.
				/platform\/(folder\.epicenter-host|shell-lifetime)\.ts$|folder\/src\/(tauri|tauri-adapter|bun|native-store)\.ts$|folder\/src\/native\/|@tauri-apps\/api\/event|^bun:/.test(
					path,
				),
			),
		).toEqual([]);
		expect(
			modules.filter((path) => /legacy\/|open-store\.ts$|@y[+/]/.test(path)),
		).toEqual([]);
	});
});
