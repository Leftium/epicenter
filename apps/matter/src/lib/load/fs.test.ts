/**
 * Loader tests for the one filesystem boundary, under the declared-store model (ADR-0029): a
 * `matter.json` marks a table. Hermetic temp-dir cases pin the precise behaviors (name from
 * basename, readable vs unreadable, the `{}` untyped marker, unmarked folders skipped, the scope =
 * marked self + marked children, sorted), and one case over the bundled example vault proves the
 * loader feeds `assess` end to end.
 */

import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { assess } from '../core/integrity';
import { loadPath, loadTable, loadVault } from './fs';

/** A scratch directory, cleaned up after `body` runs. */
async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), 'matter-load-'));
	try {
		return await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** A typed marker. */
const pagesModel = JSON.stringify({ fields: { title: { type: 'string' } } });
/** The canonical untyped marker: a folder that is a table but declares no fields. */
const untypedMarker = '{}';

/** Create a marked table folder with the given marker text and one `.md` row. */
async function makeTable(
	dir: string,
	marker: string,
	row = '---\ntitle: X\n---',
): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'matter.json'), marker);
	await writeFile(join(dir, 'x.md'), row);
}

describe('loadTable', () => {
	test('reads a typed folder into a readable table named for its basename', async () => {
		await withTempDir(async (root) => {
			const dir = join(root, 'pages');
			await mkdir(dir);
			await writeFile(join(dir, 'matter.json'), pagesModel);
			await writeFile(join(dir, 'p1.md'), '---\ntitle: Hello\n---');

			const table = await loadTable(dir);
			expect(table.name).toBe('pages');
			if (table.status !== 'readable') throw new Error('expected readable');
			expect(table.read.view.mode).toBe('typed');
			expect(table.read.rows.map((r) => r.fileName)).toEqual(['p1.md']);
		});
	});

	test('a folder marked with {} loads as a valid untyped table', async () => {
		await withTempDir(async (root) => {
			const dir = join(root, 'notes');
			await mkdir(dir);
			await writeFile(join(dir, 'matter.json'), untypedMarker);
			await writeFile(join(dir, 'n1.md'), '---\ntag: idea\n---');

			const table = await loadTable(dir);
			if (table.status !== 'readable') throw new Error('expected readable');
			expect(table.read.view.mode).toBe('untyped');
		});
	});

	test('only .md files become rows; matter.json and other files are not rows', async () => {
		await withTempDir(async (root) => {
			const dir = join(root, 'pages');
			await mkdir(dir);
			await writeFile(join(dir, 'matter.json'), pagesModel);
			await writeFile(join(dir, 'p1.md'), '---\ntitle: Hello\n---');
			await writeFile(join(dir, 'notes.txt'), 'ignore me');

			const table = await loadTable(dir);
			if (table.status !== 'readable') throw new Error('expected readable');
			expect(table.read.rows.map((r) => r.fileName)).toEqual(['p1.md']);
		});
	});

	test('a folder that cannot be listed is an unreadable table carrying a message', async () => {
		await withTempDir(async (root) => {
			const table = await loadTable(join(root, 'does-not-exist'));
			expect(table.name).toBe('does-not-exist');
			expect(table.status).toBe('unreadable');
			if (table.status !== 'unreadable') throw new Error('unreachable');
			expect(table.message.length).toBeGreaterThan(0);
		});
	});
});

describe('loadVault', () => {
	test('loads every MARKED immediate subfolder as a table, sorted, ignoring loose files', async () => {
		await withTempDir(async (root) => {
			// Created out of order to prove the loader sorts.
			await makeTable(join(root, 'pages'), pagesModel);
			await makeTable(join(root, 'adaptations'), pagesModel);
			await writeFile(join(root, 'README.md'), '# not a table');

			const tables = await loadVault(root);
			expect(tables.map((t) => t.name)).toEqual(['adaptations', 'pages']);
			expect(tables.every((t) => t.status === 'readable')).toBe(true);
		});
	});

	test('skips unmarked subfolders: a folder with no matter.json is not a table', async () => {
		await withTempDir(async (root) => {
			await makeTable(join(root, 'pages'), pagesModel);
			// An unmarked folder (an attachment bundle / junk dir): no matter.json, so not loaded.
			const assets = join(root, 'assets');
			await mkdir(assets);
			await writeFile(join(assets, 'cover.md'), '---\ncaption: hi\n---');

			const tables = await loadVault(root);
			expect(tables.map((t) => t.name)).toEqual(['pages']);
		});
	});

	test('an empty root loads as an empty set, not an error', async () => {
		await withTempDir(async (root) => {
			expect(await loadVault(root)).toEqual([]);
		});
	});

	test('an unreadable root loads as an empty set, not a throw', async () => {
		await withTempDir(async (root) => {
			expect(await loadVault(join(root, 'does-not-exist'))).toEqual([]);
		});
	});

	test('hidden directories (.git, .obsidian) are not tables even if marked', async () => {
		await withTempDir(async (root) => {
			await makeTable(join(root, 'pages'), pagesModel);
			// A hidden dir is skipped before the marker is even checked.
			await makeTable(join(root, '.obsidian'), pagesModel);

			const tables = await loadVault(root);
			expect(tables.map((t) => t.name)).toEqual(['pages']);
		});
	});
});

describe('loadPath: scope = marked self + marked children', () => {
	test('a marked folder with no marked children is a lone table', async () => {
		await withTempDir(async (root) => {
			const dir = join(root, 'pages');
			await makeTable(dir, pagesModel);

			const tables = await loadPath(dir);
			expect(tables.map((t) => t.name)).toEqual(['pages']);
			// A lone table (length 1) is what the CLI treats as "references un-evaluable".
			expect(tables).toHaveLength(1);
		});
	});

	test('an unmarked folder yields just its marked children, sorted', async () => {
		await withTempDir(async (root) => {
			// The root itself is not marked; it is just a container of tables.
			await makeTable(join(root, 'pages'), pagesModel);
			await makeTable(join(root, 'adaptations'), pagesModel);
			await writeFile(join(root, 'README.md'), '# loose file, ignored');

			const tables = await loadPath(root);
			expect(tables.map((t) => t.name)).toEqual(['adaptations', 'pages']);
		});
	});

	test('a marked folder that nests marked children is itself a table PLUS its subtables', async () => {
		await withTempDir(async (root) => {
			// First-class nesting: the parent has its own rows AND child tables.
			const parent = join(root, 'pages');
			await makeTable(parent, pagesModel);
			await makeTable(join(parent, 'drafts'), pagesModel);
			await makeTable(join(parent, 'archive'), pagesModel);

			const tables = await loadPath(parent);
			// Self first, then immediate marked children sorted: no recursion past one level.
			expect(tables.map((t) => t.name)).toEqual(['pages', 'archive', 'drafts']);
		});
	});

	test('an unmarked subfolder under a marked folder is not a subtable', async () => {
		await withTempDir(async (root) => {
			const parent = join(root, 'pages');
			await makeTable(parent, pagesModel);
			// An attachment bundle: a subfolder with no matter.json is ignored, never a subtable.
			const images = join(parent, 'images');
			await mkdir(images);
			await writeFile(join(images, 'cover.md'), '---\ncaption: hi\n---');

			const tables = await loadPath(parent);
			expect(tables.map((t) => t.name)).toEqual(['pages']);
		});
	});

	test('an unmarked folder with no marked children loads nothing (no tables here)', async () => {
		await withTempDir(async (root) => {
			const dir = join(root, 'notes');
			await mkdir(dir);
			await writeFile(join(dir, 'n1.md'), '---\ntag: idea\n---');
			await mkdir(join(dir, 'images')); // also unmarked

			const tables = await loadPath(dir);
			expect(tables).toEqual([]);
		});
	});

	test('hidden directories are never tables nor subtables', async () => {
		await withTempDir(async (root) => {
			const dir = join(root, 'notes');
			await makeTable(dir, pagesModel);
			await makeTable(join(dir, '.git'), pagesModel); // hidden: skipped

			const tables = await loadPath(dir);
			expect(tables.map((t) => t.name)).toEqual(['notes']);
		});
	});

	test('a path that cannot be listed is one unreadable table', async () => {
		await withTempDir(async (root) => {
			const tables = await loadPath(join(root, 'nope'));
			expect(tables).toHaveLength(1);
			expect(tables[0]?.status).toBe('unreadable');
		});
	});
});

describe('loadVault feeds the pipeline', () => {
	const appRoot = resolve(import.meta.dir, '../../..');
	const exampleVault = resolve(appRoot, '../../examples/matter/content-vault');

	test('the bundled content-vault loads three typed tables that assess', async () => {
		const tables = await loadVault(exampleVault);
		expect(tables.map((t) => t.name)).toEqual([
			'adaptations',
			'pages',
			'publications',
		]);

		// The whole point of the loader: its output is exactly what `assess` consumes.
		const integrity = assess(tables);
		expect(integrity.tables.map((t) => t.status)).toEqual([
			'typed',
			'typed',
			'typed',
		]);
	});

	test('loadTable on a single table folder names it for the folder', async () => {
		const table = await loadTable(join(exampleVault, 'pages'));
		expect(table.name).toBe(basename(join(exampleVault, 'pages')));
		expect(table.name).toBe('pages');
		expect(table.status).toBe('readable');
	});
});
