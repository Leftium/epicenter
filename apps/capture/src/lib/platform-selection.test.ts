/**
 * Platform Selection Tests
 *
 * A dropped seam leaf fails no build: resolution falls back to `default` and
 * the desktop page quietly opens a browser folder in IndexedDB. These tests
 * read the declarations and the bundles and name what broke.
 *
 * Key behaviors:
 * - `#platform/folder` declares an Epicenter host leaf and a browser default
 * - The host leaf reaches its folder over the bridge only: the leaf that
 *   opens a browser folder and every native module are absent from its graph
 * - The browser leaf contains no bridge client and no desktop shell API
 * - The bridge the host mounts never reaches page-only code, and the contract
 *   the host's route table imports has no runtime imports at all
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
	exports: Record<string, string>;
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

const SEAM_ENTRY = 'src/lib/platform-selection.test-support.ts';

describe('#platform/folder', () => {
	test('declares the Epicenter host leaf and the browser default', () => {
		expect(manifest.imports['#platform/folder']).toEqual({
			'epicenter-host': './src/lib/platform/folder.epicenter-host.ts',
			default: './src/lib/platform/folder.browser.ts',
		});
	});

	test('the host build resolves the bridge leaf and nothing that stores a folder', async () => {
		const modules = await inputs(SEAM_ENTRY, {
			target: 'browser',
			conditions: ['epicenter-host'],
		});
		expect(
			modules.some((path) =>
				path.endsWith('platform/folder.epicenter-host.ts'),
			),
		).toBe(true);
		expect(modules.some((path) => path.endsWith('bridge/client.ts'))).toBe(
			true,
		);
		expect(
			modules.some((path) => path.endsWith('platform/shell-lifetime.ts')),
		).toBe(true);
		// The files package's browser entry is in the graph for its Markdown
		// framing, which the document model uses. What must be absent is the
		// leaf that opens a browser folder, and anything native.
		expect(
			modules.filter((path) =>
				/platform\/folder\.browser\.ts$|files\/(native|native-store)\.ts$|^node:|capture\/native\//.test(
					path,
				),
			),
		).toEqual([]);
	});

	test('the browser build resolves the browser leaf, no bridge, and no shell API', async () => {
		const modules = await inputs(SEAM_ENTRY, { target: 'browser' });
		expect(
			modules.some((path) => path.endsWith('platform/folder.browser.ts')),
		).toBe(true);
		expect(
			modules.some((path) => path.endsWith('files/browser-store.ts')),
		).toBe(true);
		expect(
			modules.filter((path) =>
				/platform\/folder\.epicenter-host\.ts$|bridge\/client\.ts$|@tauri-apps|capture\/native\//.test(
					path,
				),
			),
		).toEqual([]);
	});
});

describe('@epicenter/capture-app/native', () => {
	test('exports the bridge contract and the native bridge, without page code', async () => {
		expect(manifest.exports).toEqual({
			'./bridge': './src/lib/bridge/contract.ts',
			'./native': './native/index.ts',
		});
		// The contract is what the host's route table imports: no runtime imports.
		expect(
			await inputs('src/lib/bridge/contract.ts', { target: 'bun' }),
		).toEqual(['src/lib/bridge/contract.ts']);

		const modules = await inputs('native/index.ts', { target: 'bun' });
		expect(modules.some((path) => path.endsWith('files/native.ts'))).toBe(true);
		expect(
			modules.filter((path) =>
				/\.svelte(\.ts)?$|bridge\/client\.ts$|platform\/|legacy\//.test(path),
			),
		).toEqual([]);
	});
});

describe('the old store', () => {
	test('is not in the folder leaf or the native bridge, only in recovery', async () => {
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
