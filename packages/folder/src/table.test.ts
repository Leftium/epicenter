/**
 * Current-row commands and captured complete-source replacements.
 *
 * Exercises real IndexedDB publication with competing writes at the boundary.
 * Updates read once and publish once, preserve unrelated current source, own
 * caller inputs before awaiting, and never retry or recreate missing rows.
 * Replacements save exact text and return submitted entries without readback.
 */
import { afterEach, expect, test } from 'bun:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createBrowserFileBoundary,
	openFolderDatabase,
} from './browser-store.js';
import { hashBytes } from './capture.js';
import { defineFolder, defineTable, field } from './contract.js';
import { compileFolderDefinition } from './definition.js';
import { FileError } from './errors.js';
import { createTable } from './table.js';

const definition = defineFolder({
	id: 'table.commands',
	kv: {},
	tables: {
		todos: defineTable({
			fields: {
				title: field.string(),
				done: field.boolean(),
				tags: field.tags(),
			},
		}),
	},
});
const encoder = new TextEncoder();
const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

async function setup() {
	const environment = { indexedDB: new IDBFactory(), IDBKeyRange };
	const db = await openFolderDatabase('table.commands', environment);
	closers.push(() => db.close());
	const base = createBrowserFileBoundary(db, environment);
	let beforeRead: (() => void) | undefined;
	let beforeApply: (() => Promise<void>) | undefined;
	let afterApply: (() => Promise<void>) | undefined;
	let reads = 0;
	let applications = 0;
	const boundary = {
		...base,
		read(path: string) {
			reads++;
			beforeRead?.();
			return base.read(path);
		},
		async apply(changes: Parameters<typeof base.apply>[0]) {
			applications++;
			await beforeApply?.();
			const result = await base.apply(changes);
			await afterApply?.();
			return result;
		},
	};
	const table = createTable<{
		title: string;
		done: boolean;
		tags: string[];
	}>(
		{ storage: boundary },
		expectOk(compileFolderDefinition(definition)).tables.get('todos')!,
	);
	const entry = expectOk(
		await table.create({
			stem: 'a',
			fields: { title: 'A', done: false, tags: [] },
			body: 'body\n',
		}),
	);
	reads = 0;
	applications = 0;
	return {
		table,
		entry,
		base,
		storage: boundary,
		counts: () => ({ reads, applications }),
		beforeRead(fn: () => void) {
			beforeRead = fn;
		},
		beforeApply(fn: () => Promise<void>) {
			beforeApply = fn;
		},
		afterApply(fn: () => Promise<void>) {
			afterApply = fn;
		},
		async overwrite(source: string) {
			const bytes = encoder.encode(source);
			expectOk(
				await base.apply([
					{
						kind: 'overwrite',
						path: entry.path,
						bytes,
						sha256: await hashBytes(bytes),
					},
				]),
			);
		},
	};
}

test('a command patches current source and preserves formatting and unrelated changes', async () => {
	const s = await setup();
	const current =
		'\uFEFF---\r\n# kept\r\ntitle: "Newer"\r\ndone: false\r\ntags: []\r\nunknown: 3\r\n---\r\nnew body\r\n';
	await s.overwrite(current);
	const next = expectOk(await s.table.update('a', { fields: { done: true } }));
	expect(next.source).toBe(current.replace('done: false', 'done: true'));
	expect(next.fields.title).toBe('Newer');
	expect(s.entry.fields.done).toBe(false);
	expect(s.counts()).toEqual({ reads: 1, applications: 1 });
});

test('a race returns Conflict after one attempt and leaves the competing bytes', async () => {
	const s = await setup();
	const external = s.entry.source.replace('title: A', 'title: External');
	s.beforeApply(() => s.overwrite(external));
	const error = expectErr(
		await s.table.update('a', { fields: { done: true } }),
	);
	expect(error.name).toBe('Conflict');
	expect(s.counts()).toEqual({ reads: 1, applications: 1 });
	expect(
		new TextDecoder().decode(expectOk(await s.base.read(s.entry.path)).bytes),
	).toBe(external);
});

test('a missing or concurrently removed row is never recreated', async () => {
	const s = await setup();
	expect(
		expectErr(await s.table.update('missing', { body: 'draft' })).name,
	).toBe('NotFound');
	expect(s.counts()).toEqual({ reads: 1, applications: 0 });
	s.beforeApply(async () => {
		expectOk(
			await s.base.apply([
				{ kind: 'remove', path: s.entry.path, expectedSha256: s.entry.sha256 },
			]),
		);
	});
	const error = expectErr(await s.table.update('a', { body: 'draft' }));
	expect(error.name).toBe('Conflict');
	expect(expectErr(await s.base.read(s.entry.path)).name).toBe('NotFound');
	expect(s.counts()).toEqual({ reads: 2, applications: 1 });
});

test('caller mutation during the read does not change submitted arrays or body', async () => {
	const s = await setup();
	const change = { fields: { tags: ['original'] }, body: 'submitted' };
	s.beforeRead(() => {
		change.fields.tags.push('later');
		change.body = 'later';
	});
	const next = expectOk(await s.table.update('a', change));
	expect(next.fields.tags).toEqual(['original']);
	expect(next.body).toBe('submitted');
});

test('unknown publication is returned once without replaying a landed command', async () => {
	const s = await setup();
	const publish = s.storage.apply;
	s.storage.apply = async (changes) => {
		expectOk(await publish(changes));
		return FileError.Unconfirmed({
			path: s.entry.path,
			operation: 'save',
			cause: 'reply lost',
		});
	};
	expect(
		expectErr(await s.table.update('a', { fields: { done: true } })).name,
	).toBe('Unconfirmed');
	expect(s.counts()).toEqual({ reads: 1, applications: 1 });
	expect(
		new TextDecoder().decode(expectOk(await s.base.read(s.entry.path)).bytes),
	).toContain('done: true');
});

test('replacement saves invalid frontmatter exactly and returns a submitted entry without rereading', async () => {
	const s = await setup();
	const source = '---\ntitle: [unfinished\n---\ndraft\n';
	s.afterApply(() => s.overwrite('another writer'));
	const next = expectOk(await s.table.replace(s.entry, source));
	expect(next.source).toBe(source);
	expect(next.issues?.some((issue) => issue.kind === 'frontmatter')).toBe(true);
	expect(next.sha256).toEqual(await hashBytes(encoder.encode(source)));
	expect(s.entry.source).not.toBe(source);
	expect(s.counts()).toEqual({ reads: 0, applications: 1 });
	expect(
		new TextDecoder().decode(expectOk(await s.base.read(s.entry.path)).bytes),
	).toBe('another writer');
	// A returned entry remains the submitted baseline, not the later writer's.
	expect(expectErr(await s.table.replace(next, 'retry draft')).name).toBe(
		'Conflict',
	);
	expect(
		new TextDecoder().decode(expectOk(await s.base.read(s.entry.path)).bytes),
	).toBe('another writer');
});

test('existing odd filenames remain editable and supplied field values remain validated', async () => {
	const s = await setup();
	expectOk(
		await s.base.apply([
			{
				kind: 'move',
				from: s.entry.path,
				to: 'todos/bad .md',
				expectedSha256: s.entry.sha256,
			},
		]),
	);
	const next = expectOk(
		await s.table.update('bad ', { fields: { done: true } }),
	);
	expect(next.fields.done).toBe(true);
	expect(next.issues?.some((issue) => issue.kind === 'filename')).toBe(true);
	expect(
		expectErr(
			await s.table.update('bad ', { fields: { done: 'wrong' as never } }),
		).name,
	).toBe('InvalidValues');
	expect(
		expectErr(await s.table.update('nested/a', { body: 'draft' })).name,
	).toBe('InvalidStem');
});

test('malformed table captures cannot recreate a removed row', async () => {
	const { table, entry } = await setup();
	expectOk(await table.delete(entry));
	const malformed = { ...entry, sha256: undefined as never };
	expect(expectErr(await table.replace(malformed, entry.source)).name).toBe(
		'InvalidPath',
	);
	expect(expectErr(await table.rename(malformed, 'b')).name).toBe(
		'InvalidPath',
	);
	expect(expectErr(await table.delete(malformed)).name).toBe('InvalidPath');
	expect(expectOk(await table.list()).entries).toEqual([]);
});
