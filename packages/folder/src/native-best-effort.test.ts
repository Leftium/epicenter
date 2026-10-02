/**
 * Concurrent creates of one row in a directory folder: exclusive creation
 * decides the winner, and no sibling file is written, claimed, or removed.
 */
import { expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { defineFolder, defineTable, field } from './contract.js';
import { compileFolderDefinition } from './definition.js';
import { scratch } from './git-http.test-support.js';
import { createNativeFileBoundary } from './native-store.js';
import { createTable } from './table.js';

const definition = defineFolder({
	id: 'so.epicenter.bestefforttest',
	kv: {},
	tables: { todos: defineTable({ fields: { title: field.string() } }) },
});

test('overlapping creates of one stem land one row and refuse the other, beside audio neither touches', async () => {
	const root = await scratch('native-best-effort-');
	try {
		await mkdir(join(root, 'todos'));
		await writeFile(join(root, 'todos/take.wav'), new Uint8Array([7, 7]));
		const base = createNativeFileBoundary(root);
		const { promise, resolve } = Promise.withResolvers<void>();
		let checks = 0;
		const boundary = {
			...base,
			async children(directory: string) {
				const result = await base.children(directory);
				// Both one-shot preflights observe vacancy before either publishes.
				if (++checks === 2) resolve();
				await promise;
				return result;
			},
		};
		const parsed = expectOk(compileFolderDefinition(definition)).tables.get(
			'todos',
		);
		if (parsed === undefined) throw new Error('Missing test declaration');
		const table = createTable<{ title: string }>(
			{ storage: boundary },
			{ name: 'todos', definition: parsed },
		);
		const results = await Promise.all([
			table.create({ stem: 'take', fields: { title: 'First' } }),
			table.create({ stem: 'take', fields: { title: 'Second' } }),
		]);
		const landed = results.filter((result) => result.error === null);
		expect(landed).toHaveLength(1);
		// Nothing of the losing create reached the folder, so it is a plain
		// refusal, not a partial publication.
		expect(
			results.find((result) => result.error !== null)?.error,
		).toMatchObject({ name: 'Exists', path: 'todos/take.md' });
		expect((await readdir(join(root, 'todos'))).sort()).toEqual([
			'take.md',
			'take.wav',
		]);
		expect(await readFile(join(root, 'todos/take.md'), 'utf8')).toBe(
			landed[0]!.data!.source,
		);
		expect(
			new Uint8Array(await readFile(join(root, 'todos/take.wav'))),
		).toEqual(new Uint8Array([7, 7]));
		const entry = expectOk(await table.get('take'));
		expect(entry?.issues).toBeUndefined();
		expect(entry?.sha256).toEqual(landed[0]!.data!.sha256);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
