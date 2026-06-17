/**
 * Loader tests for the one filesystem boundary. Hermetic temp-dir cases pin the precise behaviors
 * (name from basename, readable vs unreadable, no-matter.json as a valid untyped table, loose files
 * ignored, sorted), and one case over the bundled example vault proves the loader feeds `assess`
 * end to end.
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

const pagesModel = JSON.stringify({ fields: { title: { type: 'string' } } });

describe('loadTable', () => {
	test('reads a modeled folder into a readable table named for its basename', async () => {
		await withTempDir(async (root) => {
			const dir = join(root, 'pages');
			await mkdir(dir);
			await writeFile(join(dir, 'matter.json'), pagesModel);
			await writeFile(join(dir, 'p1.md'), '---\ntitle: Hello\n---');

			const table = await loadTable(dir);
			expect(table.name).toBe('pages');
			if (table.status !== 'readable') throw new Error('expected readable');
			expect(table.read.view.mode).toBe('modeled');
			expect(table.read.rows.map((r) => r.fileName)).toEqual(['p1.md']);
		});
	});

	test('a folder with no matter.json loads as a valid untyped table', async () => {
		await withTempDir(async (root) => {
			const dir = join(root, 'notes');
			await mkdir(dir);
			await writeFile(join(dir, 'n1.md'), '---\ntag: idea\n---');

			const table = await loadTable(dir);
			if (table.status !== 'readable') throw new Error('expected readable');
			expect(table.read.view.mode).toBe('unmodeled');
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
	test('loads every immediate subfolder as a table, sorted, ignoring loose files', async () => {
		await withTempDir(async (root) => {
			// Created out of order to prove the loader sorts.
			for (const name of ['pages', 'adaptations']) {
				const dir = join(root, name);
				await mkdir(dir);
				await writeFile(join(dir, 'x.md'), '---\ntitle: X\n---');
			}
			await writeFile(join(root, 'README.md'), '# not a table');

			const tables = await loadVault(root);
			expect(tables.map((t) => t.name)).toEqual(['adaptations', 'pages']);
			expect(tables.every((t) => t.status === 'readable')).toBe(true);
		});
	});

	test('an empty root loads as an empty vault, not an error', async () => {
		await withTempDir(async (root) => {
			expect(await loadVault(root)).toEqual([]);
		});
	});
});

describe('loadPath: scope inference', () => {
	test('a folder with a matter.json is one table, even if it has subfolders', async () => {
		await withTempDir(async (root) => {
			const dir = join(root, 'pages');
			await mkdir(dir);
			await writeFile(join(dir, 'matter.json'), pagesModel);
			await writeFile(join(dir, 'p1.md'), '---\ntitle: Hello\n---');
			await mkdir(join(dir, 'attachments')); // a stray subfolder must not make it a vault

			const { scope, tables } = await loadPath(dir);
			expect(scope).toBe('table');
			expect(tables.map((t) => t.name)).toEqual(['pages']);
		});
	});

	test('a folder of subfolders and no matter.json is a vault', async () => {
		await withTempDir(async (root) => {
			for (const name of ['pages', 'adaptations']) {
				const dir = join(root, name);
				await mkdir(dir);
				await writeFile(join(dir, 'x.md'), '---\ntitle: X\n---');
			}
			await writeFile(join(root, 'README.md'), '# loose file, ignored');

			const { scope, tables } = await loadPath(root);
			expect(scope).toBe('vault');
			expect(tables.map((t) => t.name)).toEqual(['adaptations', 'pages']);
		});
	});

	test('a raw leaf folder (md only, no matter.json, no subfolders) is one table', async () => {
		await withTempDir(async (root) => {
			const dir = join(root, 'notes');
			await mkdir(dir);
			await writeFile(join(dir, 'n1.md'), '---\ntag: idea\n---');

			const { scope, tables } = await loadPath(dir);
			expect(scope).toBe('table');
			expect(tables[0]?.status).toBe('readable');
		});
	});

	test('a path that cannot be listed is one unreadable table', async () => {
		await withTempDir(async (root) => {
			const { scope, tables } = await loadPath(join(root, 'nope'));
			expect(scope).toBe('table');
			expect(tables[0]?.status).toBe('unreadable');
		});
	});
});

describe('loadVault feeds the pipeline', () => {
	const appRoot = resolve(import.meta.dir, '../../..');
	const exampleVault = resolve(appRoot, '../../examples/matter/content-vault');

	test('the bundled content-vault loads three modeled tables that assess', async () => {
		const tables = await loadVault(exampleVault);
		expect(tables.map((t) => t.name)).toEqual([
			'adaptations',
			'pages',
			'publications',
		]);

		// The whole point of the loader: its output is exactly what `assess` consumes.
		const integrity = assess(tables);
		expect(integrity.tables.map((t) => t.status)).toEqual([
			'modeled',
			'modeled',
			'modeled',
		]);
	});

	test('loadTable on a single table folder names it for the folder', async () => {
		const table = await loadTable(join(exampleVault, 'pages'));
		expect(table.name).toBe(basename(join(exampleVault, 'pages')));
		expect(table.name).toBe('pages');
		expect(table.status).toBe('readable');
	});
});
