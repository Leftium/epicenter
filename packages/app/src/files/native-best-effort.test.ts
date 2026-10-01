/** Concurrent native creates may leave repairable attachments without losing their bytes. */
import { expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { defineStore, defineTable, field } from '../index.js';
import { compileFolderDefinition } from './folder.js';
import { scratch } from './git-http.test-support.js';
import { createNativeFileBoundary } from './native-store.js';
import { createFileTable } from './table.js';

const definition = defineStore({
	id: 'so.epicenter.bestefforttest',
	kv: {},
	tables: { todos: defineTable({ fields: { title: field.string() } }) },
});

test('overlapping creates keep both attachments and report the losing row as Partial', async () => {
	const root = await scratch('native-best-effort-');
	try {
		await mkdir(join(root, 'todos'));
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
		const parsed = compileFolderDefinition(definition).tables.get('todos');
		if (parsed === undefined) throw new Error('Missing test declaration');
		const table = createFileTable('todos', parsed, {
			boundary,
			admit: (work) => work(),
			publish: (changes) => boundary.apply(changes),
		});
		const results = await Promise.all([
			table.create({
				stem: 'take',
				fields: { title: 'First' },
				attachment: { extension: 'png', bytes: new Uint8Array([1]) },
			}),
			table.create({
				stem: 'take',
				fields: { title: 'Second' },
				attachment: { extension: 'jpg', bytes: new Uint8Array([2]) },
			}),
		]);
		expect(results.filter((result) => result.error === null)).toHaveLength(1);
		expect(results.find((result) => result.error !== null)?.error?.name).toBe(
			'Partial',
		);
		expect((await readdir(join(root, 'todos'))).sort()).toEqual([
			'take.jpg',
			'take.md',
			'take.png',
		]);
		expect(
			new Uint8Array(await readFile(join(root, 'todos/take.png'))),
		).toEqual(new Uint8Array([1]));
		expect(
			new Uint8Array(await readFile(join(root, 'todos/take.jpg'))),
		).toEqual(new Uint8Array([2]));
		const entry = expectOk(await table.get('take'));
		expect(
			entry?.issues?.find((issue) => issue.kind === 'attachment'),
		).toMatchObject({
			kind: 'attachment',
			candidates: ['todos/take.jpg', 'todos/take.png'],
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
