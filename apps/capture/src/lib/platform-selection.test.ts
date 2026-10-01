/**
 * Platform Selection Tests
 *
 * A dropped seam leaf fails no build: resolution falls back to `default` and
 * the desktop page quietly opens a browser folder in IndexedDB. These tests
 * read the declarations and the bundles and name what broke.
 *
 * Key behaviors:
 * - `#platform/folder` declares an Epicenter host leaf and a browser default
 * - The host leaf opens through the desktop folder adapter only: the browser
 *   leaf, the browser adapter and its IndexedDB store, any Git implementation,
 *   the directory opener, and every Node module are absent from its bundle
 * - The browser leaf carries the browser adapter and no desktop adapter, no
 *   generated native bindings, and no shell quit protocol
 * - The package exports nothing: no host mounts a part of this app
 * - The old store definition is reachable only from the recovery module
 */
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const appDir = join(import.meta.dir, '..', '..');
const manifest = JSON.parse(
	await readFile(join(appDir, 'package.json'), 'utf8'),
) as {
	imports: Record<string, Record<string, string>>;
	exports?: Record<string, string>;
};

/** Every module that reaches a bundle of `entry`, as paths. Built in its own process. */
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

const SEAM_ENTRY = 'src/lib/platform-selection.test-support.ts';

/** The transport this app used before the shell owned its folder. */
const RETIRED = /capture\/native\/|lib\/bridge\//;

describe('#platform/folder', () => {
	test('declares the Epicenter host leaf and the browser default', () => {
		expect(manifest.imports['#platform/folder']).toEqual({
			'epicenter-host': './src/lib/platform/folder.epicenter-host.ts',
			default: './src/lib/platform/folder.browser.ts',
		});
	});

	test('the host build opens through the desktop adapter and carries nothing that stores a folder', async () => {
		const modules = await inputs(SEAM_ENTRY, {
			target: 'browser',
			conditions: ['epicenter-host'],
		});
		for (const required of [
			'platform/folder.epicenter-host.ts',
			'platform/shell-lifetime.ts',
			'folder/src/tauri.ts',
			'folder/src/tauri-adapter.ts',
			'folder/src/native/bindings.gen.ts',
		])
			expect(modules.filter((path) => path.endsWith(required))).toHaveLength(1);
		expect(
			modules.filter(
				(path) =>
					/platform\/folder\.browser\.ts$|folder\/src\/(browser|browser-adapter|browser-store|bun|native-store)\.ts$|folder\/src\/git\/(browser|native)-|isomorphic-git|^node:|^bun:/.test(
						path,
					) || RETIRED.test(path),
			),
		).toEqual([]);
	});

	test('the browser build opens through the browser adapter, with no desktop adapter and no shell protocol', async () => {
		const modules = await inputs(SEAM_ENTRY, { target: 'browser' });
		for (const required of [
			'platform/folder.browser.ts',
			'folder/src/browser.ts',
			'folder/src/browser-adapter.ts',
			'folder/src/browser-store.ts',
		])
			expect(modules.filter((path) => path.endsWith(required))).toHaveLength(1);
		expect(
			modules.filter(
				(path) =>
					// The browser adapter asks `isTauri()` so it can refuse there; that one
					// module of the Tauri API is its only use of it.
					/platform\/(folder\.epicenter-host|shell-lifetime)\.ts$|folder\/src\/(tauri|tauri-adapter|bun|native-store)\.ts$|folder\/src\/native\/|@tauri-apps\/api\/event|^bun:/.test(
						path,
					) || RETIRED.test(path),
			),
		).toEqual([]);
	});
});

describe('@epicenter/capture-app', () => {
	test('exports nothing for a host to mount', () => {
		expect(manifest.exports).toBeUndefined();
	});
});

describe('the old store', () => {
	test('is not in either folder leaf, only in recovery', async () => {
		for (const conditions of [[], ['epicenter-host']]) {
			const modules = await inputs(SEAM_ENTRY, {
				target: 'browser',
				conditions,
			});
			expect(
				modules.filter((path) => /legacy\/|open-store\.ts$|@y\/y/.test(path)),
			).toEqual([]);
		}
		const recovery = await inputs('src/lib/recovery/legacy-account.ts', {
			target: 'browser',
		});
		expect(recovery.some((path) => path.endsWith('legacy/definition.ts'))).toBe(
			true,
		);
	});
});
