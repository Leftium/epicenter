/**
 * File Table Tests
 *
 * Exercises real IndexedDB publication with competing writes at the boundary.
 * A table captures a row file first and interprets its text second, so these
 * tests keep three things apart: whether a file was read, whether its text
 * parses, and whether its fields conform.
 *
 * Key behaviors:
 * - A snapshot is the captured file beside its flat reading: a parse failure
 *   leaves no fields, body, or issues; parsed text keeps every field that
 *   validated beside the issues of the rest, and `fields` stays partial
 * - `inspect` is the one interpreter: reads, receipts, and drafts agree, and
 *   it supplies no default and coerces nothing
 * - Interpreted values and diagnostics are frozen at every depth; supplied
 *   values are copied and the caller's objects are left as they were
 * - A field's refinement is shown only the table's own frozen value, parsed
 *   or copied: one that changes it is a field issue and changes nothing
 * - A YAML value that is not JSON is an issue under a declared field and
 *   untouched under an undeclared key; neither stops the rest from reading
 * - A receipt reads the text of the bytes that were submitted, never the
 *   objects or the string the caller passed
 * - `get` is `undefined` only for absence; `list` has one item per `.md` file
 *   with its own Result, and an outer error only when the listing failed
 * - Every literal single-segment stem is an address, the empty one included;
 *   only the exact lowercase `.md` extension is a row
 * - An occupied destination is the file `Exists` error; names are never
 *   folded, so a differently cased name is a different file here
 * - Updates validate input, read once, require the source to parse, patch
 *   only assigned spans, and publish once; they never rewrite on a refusal
 * - Replacement saves exact text, malformed included, and returns the
 *   submitted capture without rereading; a stale capture conflicts
 *
 * See also:
 * - `markdown.test.ts` for framing, YAML, and patch refusals
 * - `native.test.ts` for the same table over a real directory
 */
import { afterEach, expect, test } from 'bun:test';
import { type DataSchema, jsonValue } from '@epicenter/definition';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { Result } from 'wellcrafted/result';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createBrowserFileBoundary,
	openFolderDatabase,
} from './browser-store.js';
import { hashBytes } from './capture.js';
import { defineFolder, defineTable, field } from './contract.js';
import { FileError, type TableWriteError } from './errors.js';
import { rowPath, rowStemOf } from './paths.js';
import { createTable, type TableSnapshot } from './table.js';

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: {
				title: field.string(),
				done: field.boolean(),
				tags: field.tags(),
			},
		}),
		bare: defineTable({ fields: {} }),
		loose: defineTable({ fields: { data: field.json(jsonValue) } }),
		dated: defineTable({
			fields: {
				due: field.nullable(field.string()),
				// A native schema whose `default` annotation nothing applies.
				label: { type: 'string', default: 'untitled' },
			},
		}),
	},
});
type Todo = { title: string; done: boolean; tags: string[] };
type TodoSnapshot = TableSnapshot<Todo>;

/**
 * The file table for one table of a prepared definition, the way a folder
 * builds one: named by its key and given that table's prepared fields.
 */
function tableOf<TFields>(
	storage: Parameters<typeof createTable>[0]['storage'],
	prepared: DataSchema,
	name: string,
) {
	const declared = prepared.tables[name];
	if (declared === undefined) throw new Error(`no table '${name}'`);
	return createTable<TFields>(
		{ storage, onFilesChanged: () => () => {} },
		name,
		declared.fields,
	);
}

/** The interpretation a snapshot carries, without its capture. */
const readingOf = ({ fields, body, parseError, issues }: TodoSnapshot) => ({
	fields,
	body,
	parseError,
	issues,
});

/** Every object and array reachable from a value. */
function nodesOf(value: unknown, found: object[] = []): object[] {
	if (typeof value !== 'object' || value === null || found.includes(value))
		return found;
	found.push(value);
	for (const child of Object.values(value)) nodesOf(child, found);
	return found;
}
const encoder = new TextEncoder();
// A byte-order mark is part of the stored text, so it is not stripped here.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
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
	let beforeReadMany: (() => Promise<void>) | undefined;
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
		async readMany(paths: readonly string[]) {
			await beforeReadMany?.();
			return base.readMany(paths);
		},
		async apply(changes: Parameters<typeof base.apply>[0]) {
			applications++;
			await beforeApply?.();
			const result = await base.apply(changes);
			await afterApply?.();
			return result;
		},
	};
	const table = tableOf<Todo>(boundary, definition, 'todos');
	const entry = expectOk(
		await table.create({
			stem: 'a',
			fields: { title: 'A', done: false, tags: [] },
			body: 'body\n',
		}),
	);
	reads = 0;
	applications = 0;
	/** Put exact bytes at a path without going through the table. */
	async function put(path: string, content: string | Uint8Array) {
		const bytes =
			typeof content === 'string' ? encoder.encode(content) : content;
		expectOk(
			await base.apply([
				{ kind: 'overwrite', path, bytes, sha256: await hashBytes(bytes) },
			]),
		);
	}
	return {
		table,
		entry,
		base,
		storage: boundary,
		put,
		counts: () => ({ reads, applications }),
		beforeRead(fn: () => void) {
			beforeRead = fn;
		},
		beforeReadMany(fn: () => Promise<void>) {
			beforeReadMany = fn;
		},
		beforeApply(fn: () => Promise<void>) {
			beforeApply = fn;
		},
		afterApply(fn: () => Promise<void>) {
			afterApply = fn;
		},
		overwrite: (source: string) => put(entry.path, source),
		async stored(path = entry.path) {
			return decoder.decode(expectOk(await base.read(path)).bytes);
		},
	};
}

const VALID = '---\ntitle: External\ndone: false\ntags: []\n---\n';
const MALFORMED = '---\ntitle: [unfinished\n---\ndraft\n';

// -- Capture and interpretation ---------------------------------------------

test('a snapshot is the captured file beside how that exact text reads', async () => {
	const { table, entry } = await setup();
	expect(entry).toEqual({
		path: 'todos/a.md',
		stem: 'a',
		source: '---\ntitle: A\ndone: false\ntags: []\n---\nbody\n',
		sha256: await hashBytes(encoder.encode(entry.source)),
		fields: { title: 'A', done: false, tags: [] },
		body: 'body\n',
		parseError: undefined,
		issues: [],
	});
	// A read, a receipt, and a draft are interpreted by the same function.
	expect(expectOk(await table.get('a'))).toEqual(entry);
	const draft = table.inspect(entry.source);
	expect(draft).toEqual(readingOf(entry));
	// A draft is a plain reading: it invents no path, hash, or Result.
	expect(Object.keys(draft).sort()).toEqual([
		'body',
		'fields',
		'issues',
		'parseError',
	]);
});

test('malformed saved text is still a selectable capture, and only absence is undefined', async () => {
	const s = await setup();
	await s.overwrite(MALFORMED);
	const read = expectOk(await s.table.get('a'));
	// A parse failure exposes no recovered fields, issues, or body.
	expect(read).toEqual({
		path: 'todos/a.md',
		stem: 'a',
		source: MALFORMED,
		sha256: await hashBytes(encoder.encode(MALFORMED)),
		fields: {},
		body: undefined,
		parseError: expect.objectContaining({
			message: expect.stringContaining('not valid YAML'),
		}),
		issues: [],
	});
	expect(read?.parseError?.diagnostics.length).toBeGreaterThan(0);
	expect(expectOk(await s.table.get('missing'))).toBeUndefined();
});

test('each declared field validates by itself, and unknown keys are not issues', () => {
	const table = tableOf<Todo>(undefined as never, definition, 'todos');
	const unknown = table.inspect(
		'---\ntitle: A\ndone: false\ntags: []\nextra: {a: 1}\n---\n',
	);
	expect(unknown.issues).toEqual([]);
	expect(unknown.fields).toEqual({ title: 'A', done: false, tags: [] });

	const partial = table.inspect(
		'---\ntitle: Kept\ndone: maybe\ntags: [a, 3]\n---\nBody\n',
	);
	// One field's failure does not take a field that validated with it, and
	// nothing turns the text `maybe` into a boolean.
	expect(partial.fields).toEqual({ title: 'Kept' });
	expect(partial.body).toBe('Body\n');
	expect(partial.parseError).toBeUndefined();
	expect(partial.issues.map((issue) => issue.field)).toEqual(['done', 'tags']);
	// The validator names the failing item of the array, so the issue does too.
	expect(partial.issues[1]).toMatchObject({ field: 'tags', path: '/1' });
	expect(partial.issues[0]).not.toHaveProperty('path');
	for (const issue of partial.issues)
		expect(Object.keys(issue).sort()).toEqual(
			'path' in issue ? ['field', 'message', 'path'] : ['field', 'message'],
		);

	// The body is a string whenever the source parses, even an empty one.
	const missing = table.inspect('---\n---\n');
	expect(missing).toMatchObject({
		fields: {},
		body: '',
		parseError: undefined,
	});
	expect(missing.issues.map((issue) => issue.field)).toEqual([
		'title',
		'done',
		'tags',
	]);

	// Parsing is a separate phase: it fails with no fields, body, or issues.
	for (const source of ['Body only\n', '---\ntitle: A\n', MALFORMED, '']) {
		const reading = table.inspect(source);
		expect(reading).toEqual({
			fields: {},
			body: undefined,
			parseError: expect.anything(),
			issues: [],
		});
		const [first] = reading.parseError?.diagnostics ?? [];
		expect(typeof first?.message).toBe('string');
	}
});

test('an absent declared field is an issue, a nullable one included, and no default is supplied', () => {
	const dated = tableOf<{ due: string | null; label: string }>(
		undefined as never,
		definition,
		'dated',
	);
	const absent = dated.inspect('---\n---\n');
	expect(absent.fields).toEqual({});
	expect(absent.issues.map((issue) => issue.field)).toEqual(['due', 'label']);

	// A stored null is a value; the key not being there is not.
	const stored = dated.inspect('---\ndue: null\n---\n');
	expect(stored.fields).toEqual({ due: null });
	expect(Object.hasOwn(stored.fields, 'label')).toBe(false);
	expect(stored.issues.map((issue) => issue.field)).toEqual(['label']);
});

test('YAML values that are not JSON never break a reading: a declared one is an issue, an undeclared one stays in the source, and the rest still reads', async () => {
	const s = await setup();
	// Bytes, a date, a set, and a number that is not finite: declared at the
	// top, nested in a declared value, and under keys nothing declares.
	const source = [
		'---',
		'title: usable',
		'done: !!binary SGVsbG8=',
		'tags: [a, !!binary SGVsbG8=]',
		'blob: !!binary SGVsbG8=',
		'extra: {bytes: !!binary SGVsbG8=, when: 2026-10-01, set: !!set {a}, n: .inf}',
		'---',
		'body\n',
	].join('\n');
	const reading = s.table.inspect(source);
	expect(reading.parseError).toBeUndefined();
	expect(reading.fields).toEqual({ title: 'usable' });
	expect(reading.body).toBe('body\n');
	expect(reading.issues.map((issue) => issue.field).sort()).toEqual([
		'done',
		'tags',
	]);
	for (const node of nodesOf(reading)) expect(Object.isFrozen(node)).toBe(true);

	// A declared field that accepts any JSON still refuses bytes inside it.
	const loose = tableOf<{ data: unknown }>(s.storage, definition, 'loose');
	const nested = loose.inspect('---\ndata: {bytes: !!binary SGVsbG8=}\n---\n');
	expect(nested.fields).toEqual({});
	expect(nested.issues.map((issue) => issue.field)).toEqual(['data']);

	// A complete replacement is published as written, and reads the same way
	// from its receipt, a get, and a listing.
	const replaced = expectOk(await s.table.replace(s.entry, source));
	expect(await s.stored()).toBe(source);
	expect(readingOf(replaced)).toEqual(reading);
	expect(replaced.source).toBe(source);
	expect(expectOk(await s.table.get('a'))).toEqual(replaced);
	const [listed] = expectOk(await s.table.list());
	expect(expectOk(listed!.result)).toEqual(replaced);

	// The field beside them updates, and their text stays as written.
	const updated = expectOk(
		await s.table.update('a', { fields: { title: 'still usable' } }),
	);
	expect(updated.source).toBe(
		source.replace('title: usable', 'title: still usable'),
	);
	expect(updated.fields).toEqual({ title: 'still usable' });
});

test('a reading is frozen at every depth, parse errors and issues included', () => {
	const loose = tableOf<{ data: unknown }>(
		undefined as never,
		definition,
		'loose',
	);
	// The alias makes one parsed node reachable from two places.
	const nested = loose.inspect(
		'---\ndata:\n  list: &shared [1, {deep: [2]}]\n  again: *shared\n---\n',
	);
	expect(nested.fields).toEqual({
		data: { list: [1, { deep: [2] }], again: [1, { deep: [2] }] },
	});
	const todos = tableOf<Todo>(undefined as never, definition, 'todos');
	for (const reading of [
		nested,
		todos.inspect('---\ntitle: A\ntags: [a, 3]\n---\n'),
		todos.inspect(MALFORMED),
	]) {
		const nodes = nodesOf(reading);
		expect(nodes.length).toBeGreaterThan(3);
		for (const node of nodes) expect(Object.isFrozen(node)).toBe(true);
	}
	const data = nested.fields.data as { list: unknown[] };
	expect(() => data.list.push(3)).toThrow(TypeError);

	// Two readings of one source share nothing a caller could change.
	const again = todos.inspect('---\ntitle: A\ndone: false\ntags: [a]\n---\n');
	const other = todos.inspect('---\ntitle: A\ndone: false\ntags: [a]\n---\n');
	expect(again.fields.tags).toEqual(other.fields.tags);
	expect(again.fields.tags).not.toBe(other.fields.tags);
});

test('supplied values are copied: the caller keeps mutable objects, and a receipt holds none of them', async () => {
	const s = await setup();
	const tags = ['one'];
	const fields = { title: 'B', done: false, tags };
	const created = expectOk(await s.table.create({ stem: 'b', fields }));
	expect(Object.isFrozen(fields)).toBe(false);
	expect(Object.isFrozen(tags)).toBe(false);
	expect(created.fields.tags).toEqual(['one']);
	expect(created.fields.tags).not.toBe(tags);
	// The caller's later change reaches neither the receipt nor the file.
	tags.push('later');
	expect(created.fields.tags).toEqual(['one']);
	expect(expectOk(await s.table.get('b'))).toEqual(created);

	// Frozen snapshot values go back in as they are, and come out as new copies.
	const updated = expectOk(
		await s.table.update('a', { fields: created.fields, body: 'next\n' }),
	);
	expect(updated.fields).toEqual(created.fields);
	expect(updated.fields.tags).not.toBe(created.fields.tags);
	expect(Object.isFrozen(updated.fields.tags)).toBe(true);
	const change = { fields: { tags: ['two'] } };
	expectOk(await s.table.update('a', change));
	expect(Object.isFrozen(change.fields.tags)).toBe(false);
});

test('a receipt reads the text of the submitted bytes, not the string that was passed', async () => {
	const s = await setup();
	// Encoding replaces an unpaired surrogate, so the bytes say U+FFFD.
	const passed = '---\ntitle: "lone \ud800"\ndone: false\ntags: []\n---\n';
	const saved = passed.replace('\ud800', '�');
	const receipt = expectOk(await s.table.replace(s.entry, passed));
	expect(receipt.source).toBe(saved);
	expect(receipt.sha256).toBe(await hashBytes(encoder.encode(passed)));
	expect(receipt.fields.title).toBe('lone �');
	// The receipt is what a read of those bytes returns, with no read made.
	expect(s.counts().reads).toBe(0);
	expect(expectOk(await s.table.get('a'))).toEqual(receipt);
	expect(readingOf(receipt)).toEqual(s.table.inspect(saved));
});

// -- Listing ----------------------------------------------------------------

test('a listing has one item per row file, each with its own result', async () => {
	const s = await setup();
	await s.put('todos/broken.md', MALFORMED);
	await s.put('todos/binary.md', new Uint8Array([0xff, 0xfe, 0xfd]));
	await s.put('todos/partial.md', '---\ntitle: Kept\n---\n');
	// Not rows: another extension, an uppercase extension, and a nested file.
	await s.put('todos/a.txt', 'text');
	await s.put('todos/UPPER.MD', VALID);
	await s.put('todos/nested/b.md', VALID);

	const listing = expectOk(await s.table.list());
	expect(listing.map((item) => item.path).sort()).toEqual([
		'todos/a.md',
		'todos/binary.md',
		'todos/broken.md',
		'todos/partial.md',
	]);
	const item = (path: string) => listing.find((found) => found.path === path)!;

	expect(expectOk(item('todos/a.md').result)).toEqual(s.entry);
	// Readable malformed text is a successful snapshot with a parse error.
	const broken = expectOk(item('todos/broken.md').result);
	expect(broken.source).toBe(MALFORMED);
	expect(readingOf(broken)).toEqual(s.table.inspect(MALFORMED));
	expect(broken.parseError).toBeDefined();
	const partial = expectOk(item('todos/partial.md').result);
	expect(partial.fields).toEqual({ title: 'Kept' });
	expect(partial.issues.map((issue) => issue.field)).toEqual(['done', 'tags']);
	// Bytes that are not text are that file's error, not a skipped file.
	expect(expectErr(item('todos/binary.md').result)).toMatchObject({
		name: 'InvalidUtf8',
		path: 'todos/binary.md',
	});
	expect(expectErr(await s.table.get('binary')).name).toBe('InvalidUtf8');

	// The uppercase file stays an ordinary file the table does not address.
	expect(expectOk(await s.table.get('UPPER'))).toBeUndefined();
	const upper = expectOk(await s.base.read('todos/UPPER.MD'));
	const capture = { path: 'todos/UPPER.MD', sha256: upper.sha256 };
	expect(expectErr(await s.table.replace(capture, VALID)).name).toBe(
		'InvalidPath',
	);
	expect(expectErr(await s.table.delete(capture)).name).toBe('InvalidPath');
});

test('a file that goes away after it was enumerated is its own NotFound, not an invented entry', async () => {
	const s = await setup();
	await s.put('todos/kept.md', VALID);
	s.beforeReadMany(async () => {
		expectOk(
			await s.base.apply([
				{ kind: 'remove', path: s.entry.path, expectedSha256: s.entry.sha256 },
			]),
		);
	});
	const listing = expectOk(await s.table.list());
	expect(listing).toHaveLength(2);
	expect(
		expectErr(listing.find((item) => item.path === 'todos/a.md')!.result),
	).toMatchObject({ name: 'NotFound', path: 'todos/a.md' });
	expectOk(listing.find((item) => item.path === 'todos/kept.md')!.result);
});

test('a storage response that omits a requested row leaves that row as an I/O failure', async () => {
	const s = await setup();
	s.storage.readMany = async () => Ok(new Map());
	const listing = expectOk(await s.table.list());
	expect(listing).toHaveLength(1);
	expect(listing[0]?.path).toBe(s.entry.path);
	expect(expectErr(listing[0]!.result)).toMatchObject({
		name: 'Io',
		path: s.entry.path,
	});
});

test('a listing that cannot be acquired as a whole is an outer error, and a missing directory is empty', async () => {
	const s = await setup();
	const failed = FileError.Io({ path: 'todos', operation: 'list', cause: 'x' });
	s.storage.children = async () => failed;
	expect(expectErr(await s.table.list())).toMatchObject({ name: 'Io' });
	s.storage.children = s.base.children;
	s.storage.readMany = async () => FileError.Closed();
	expect(expectErr(await s.table.list()).name).toBe('Closed');

	const bare = tableOf<Record<string, never>>(s.base, definition, 'bare');
	expect(expectOk(await bare.list())).toEqual([]);
});

// -- Literal addresses ------------------------------------------------------

test('every literal single-segment stem is an address for every operation', async () => {
	const s = await setup();
	const fields = { title: 'Odd', done: false, tags: [] };
	// The empty stem names `todos/.md`; none of these is trimmed or folded.
	const stems = [
		'',
		'.x',
		'bad ',
		' lead',
		'a: b',
		'q?*<>|"',
		'.',
		'..',
		'CON',
	];
	for (const stem of stems) {
		const created = expectOk(await s.table.create({ stem, fields }));
		expect(created.path).toBe(rowPath('todos', stem));
		expect(created.stem).toBe(stem);
		expect(rowStemOf('todos', created.path)).toBe(stem);
		// A name is never a diagnostic.
		expect(created).toMatchObject({ parseError: undefined, issues: [] });
		expect(expectOk(await s.table.get(stem))).toEqual(created);
		const updated = expectOk(
			await s.table.update(stem, { fields: { done: true } }),
		);
		expect(updated.stem).toBe(stem);
		expect(updated.fields.done).toBe(true);
	}
	const listed = expectOk(await s.table.list()).map(
		(item) => expectOk(item.result).stem,
	);
	expect(listed.sort()).toEqual([...stems, 'a'].sort());

	// Renaming to and from odd names is an ordinary move.
	const empty = expectOk(await s.table.get(''))!;
	const named = expectOk(await s.table.rename(empty, 'named'));
	expect(named).toMatchObject({ path: 'todos/named.md', stem: 'named' });
	expect(expectOk(await s.table.get(''))).toBeUndefined();
	const back = expectOk(await s.table.rename(named, ' trailing. '));
	expect(back.path).toBe('todos/ trailing. .md');
	expectOk(await s.table.delete(back));
	expect(expectOk(await s.table.get(' trailing. '))).toBeUndefined();
});

test('a stem that is not one segment inside the folder is a scoped path refusal', async () => {
	const s = await setup();
	const fields = { title: 'New', done: false, tags: [] };
	for (const stem of ['nested/a', '../escape', 'a\\b', 'a\nb', '.git/x']) {
		expect(expectErr(await s.table.get(stem)).name).toBe('InvalidPath');
		expect(expectErr(await s.table.create({ stem, fields })).name).toBe(
			'InvalidPath',
		);
		expect(expectErr(await s.table.update(stem, { body: 'x' })).name).toBe(
			'InvalidPath',
		);
		expect(expectErr(await s.table.rename(s.entry, stem)).name).toBe(
			'InvalidPath',
		);
	}
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });
});

test('an occupied destination is the file Exists error, and a differently spelled name is another file', async () => {
	const s = await setup();
	const fields = { title: 'New', done: false, tags: [] };
	const occupied = expectErr(await s.table.create({ stem: 'a', fields }));
	expect(occupied).toMatchObject({ name: 'Exists', path: 'todos/a.md' });
	expect(await s.stored()).toBe(s.entry.source);

	// This storage keeps names exactly, so no case or Unicode folding applies.
	const upper = expectOk(await s.table.create({ stem: 'A', fields }));
	const composed = expectOk(await s.table.create({ stem: 'é', fields }));
	const decomposed = expectOk(await s.table.create({ stem: 'é', fields }));
	expect(new Set([upper.path, composed.path, decomposed.path]).size).toBe(3);
	expect(expectOk(await s.table.get('a'))).toEqual(s.entry);

	const refused = expectErr(await s.table.rename(upper, 'a'));
	expect(refused).toMatchObject({ name: 'Exists', path: 'todos/a.md' });
	expect(expectOk(await s.table.get('A'))).toEqual(upper);
	expect(expectOk(await s.table.get('a'))).toEqual(s.entry);
});

// -- Create -----------------------------------------------------------------

test('a new row always has both fences, even with no fields and no body', async () => {
	const s = await setup();
	const bare = tableOf<Record<string, never>>(s.base, definition, 'bare');
	const created = expectOk(await bare.create({ stem: 'empty', fields: {} }));
	expect(created.source).toBe('---\n---\n');
	expect(created).toMatchObject({
		body: '',
		fields: {},
		parseError: undefined,
		issues: [],
	});
	expect(expectOk(await bare.get('empty'))).toEqual(created);
	// The body alone would not parse; the fences are what make it a row.
	expect(
		expectOk(await bare.create({ stem: 'text', fields: {}, body: 'Hi\n' }))
			.source,
	).toBe('---\n---\nHi\n');
});

test('supplied values are refused before anything is read or written', async () => {
	const s = await setup();
	const loose = tableOf<{ data: unknown }>(s.storage, definition, 'loose');
	const refusals: Result<unknown, TableWriteError>[] = [
		await s.table.create({
			stem: 'b',
			fields: { title: 'B', done: 'no' as never, tags: [] },
		}),
		await s.table.create({ stem: 'b', fields: { title: 'B' } as never }),
		await s.table.update('a', { fields: { done: 'wrong' as never } }),
		await s.table.update('a', { fields: { other: 1 } as never }),
		// The field accepts any value; these cannot be copied or written.
		await loose.create({ stem: 'b', fields: { data: () => {} } }),
		await loose.create({ stem: 'b', fields: { data: Number.NaN } }),
		await loose.update('b', { fields: { data: { at: undefined } } }),
	];
	for (const refusal of refusals) {
		const error = expectErr(refusal);
		expect(error.name).toBe('InvalidValues');
		if (error.name !== 'InvalidValues') continue;
		expect(error.issues.length).toBeGreaterThan(0);
		for (const issue of error.issues) expect(issue.field).not.toBe('');
	}
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });
});

test('a supplied key named __proto__ is an undeclared key like any other: refused by name, and nothing is saved', async () => {
	const s = await setup();
	// As parsed JSON carries it: an own key, not the object's prototype.
	const fields = JSON.parse(
		'{"title": "B", "done": false, "tags": [], "__proto__": {"extra": 1}}',
	);
	for (const refused of [
		await s.table.create({ stem: 'b', fields }),
		await s.table.update('a', {
			fields: JSON.parse('{"title": "B", "__proto__": {"extra": 1}}'),
		}),
	]) {
		const error = expectErr(refused);
		expect(error.name).toBe('InvalidValues');
		if (error.name !== 'InvalidValues') continue;
		expect(error.issues).toEqual([
			{ field: '__proto__', message: '__proto__ is not declared' },
		]);
	}
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });
	expect(expectOk(await s.table.get('b'))).toBeUndefined();
	expect(await s.stored()).toBe(s.entry.source);
});

// -- Update -----------------------------------------------------------------

test('a command patches current source and preserves formatting and unrelated changes', async () => {
	const s = await setup();
	const current =
		'﻿---\r\n# kept\r\ntitle: "Newer"\r\ndone: false\r\ntags: []\r\nunknown: 3\r\n---\r\nnew body\r\n';
	await s.overwrite(current);
	const next = expectOk(await s.table.update('a', { fields: { done: true } }));
	expect(next.source).toBe(current.replace('done: false', 'done: true'));
	expect(next.fields.title).toBe('Newer');
	expect(await s.stored()).toBe(next.source);
	// The snapshot captured before the update is unchanged.
	expect(s.entry.fields.done).toBe(false);
	expect(s.counts()).toEqual({ reads: 1, applications: 1 });
});

test('an update needs the source to parse, even to change only the body, and rewrites nothing', async () => {
	const s = await setup();
	for (const source of [
		MALFORMED,
		'Body with no frontmatter\n',
		'---\na: 1\n',
	]) {
		await s.overwrite(source);
		for (const change of [{ body: 'new body\n' }, { fields: { done: true } }]) {
			const error = expectErr(await s.table.update('a', change));
			expect(error.name).toBe('Unparsed');
			if (error.name !== 'Unparsed') continue;
			expect(error.path).toBe('todos/a.md');
			expect(error.error.diagnostics.length).toBeGreaterThan(0);
		}
		expect(await s.stored()).toBe(source);
	}
	expect(s.counts().applications).toBe(0);
});

test('source that parses but cannot be patched safely is a different refusal', async () => {
	const s = await setup();
	const source =
		'---\nbase: &b A\ntitle: *b\ndone: false\ntags: []\n---\nbody\n';
	await s.overwrite(source);
	const error = expectErr(
		await s.table.update('a', { fields: { title: 'B' } }),
	);
	expect(error.name).toBe('UnsupportedSource');
	expect(await s.stored()).toBe(source);
	expect(s.counts()).toEqual({ reads: 1, applications: 0 });
	// A span the patch can replace is still assignable in the same file.
	const next = expectOk(await s.table.update('a', { fields: { done: true } }));
	expect(next.source).toBe(source.replace('done: false', 'done: true'));
});

test('issues in fields the update does not assign do not block it', async () => {
	const s = await setup();
	const source = '---\ntitle: 12\ntags: nope\ndone: false\n---\nbody\n';
	await s.overwrite(source);
	const next = expectOk(await s.table.update('a', { fields: { done: true } }));
	expect(next.source).toBe(source.replace('done: false', 'done: true'));
	expect(next.fields).toEqual({ done: true });
	expect(next.issues.map((issue) => issue.field)).toEqual(['title', 'tags']);
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
	expect(await s.stored()).toBe(external);
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
	expect(error).toMatchObject({ name: 'Conflict', actualSha256: undefined });
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
	expect(await s.stored()).toContain('done: true');
});

test('a storage failure is forwarded intact instead of being reclassified', async () => {
	const s = await setup();
	const failure = FileError.DirectoryNotEmpty({ path: 'todos' });
	s.storage.read = async () => failure;
	expect(expectErr(await s.table.get('a'))).toBe(failure.error);
});

// -- Replace ----------------------------------------------------------------

test('replacement saves malformed text exactly and returns the submitted capture without rereading', async () => {
	const s = await setup();
	s.afterApply(() => s.overwrite('another writer'));
	const next = expectOk(await s.table.replace(s.entry, MALFORMED));
	// The save succeeded; how the text reads is the receipt's parse error.
	expect(next).toMatchObject({
		path: s.entry.path,
		stem: 'a',
		source: MALFORMED,
	});
	expect(next.sha256).toEqual(await hashBytes(encoder.encode(MALFORMED)));
	expect(readingOf(next)).toEqual(s.table.inspect(MALFORMED));
	expect(next.parseError).toBeDefined();
	// The capture that was passed in is not advanced.
	expect(s.entry.source).not.toBe(MALFORMED);
	expect(s.entry.fields.title).toBe('A');
	expect(s.counts()).toEqual({ reads: 0, applications: 1 });
	expect(await s.stored()).toBe('another writer');
	// A returned entry remains the submitted baseline, not the later writer's.
	expect(expectErr(await s.table.replace(next, 'retry draft')).name).toBe(
		'Conflict',
	);
	expect(await s.stored()).toBe('another writer');
});

test('a malformed capture is a repair baseline: it can be replaced, renamed, and deleted', async () => {
	const s = await setup();
	await s.overwrite(MALFORMED);
	const broken = expectOk(await s.table.get('a'))!;
	expect(broken.parseError).toBeDefined();
	const moved = expectOk(await s.table.rename(broken, 'moved'));
	expect(moved).toMatchObject({ path: 'todos/moved.md', source: MALFORMED });
	expect(readingOf(moved)).toEqual(readingOf(broken));
	const repaired = expectOk(await s.table.replace(moved, VALID));
	expect(repaired).toMatchObject({ parseError: undefined, issues: [] });
	// Arbitrary text, an empty file included, is saved exactly.
	const emptied = expectOk(await s.table.replace(repaired, ''));
	expect(emptied.source).toBe('');
	expect(emptied.parseError).toBeDefined();
	expectOk(await s.table.delete(emptied));
	expect(expectOk(await s.table.list())).toEqual([]);
});

test('a stale capture conflicts once and changes neither the file nor the capture', async () => {
	const s = await setup();
	const external = s.entry.source.replace('title: A', 'title: External');
	await s.overwrite(external);
	const before = { ...s.entry };
	const error = expectErr(await s.table.replace(s.entry, MALFORMED));
	expect(error).toMatchObject({
		name: 'Conflict',
		expectedSha256: s.entry.sha256,
		actualSha256: await hashBytes(encoder.encode(external)),
	});
	expect(s.counts()).toEqual({ reads: 0, applications: 1 });
	expect(await s.stored()).toBe(external);
	expect(s.entry).toEqual(before);
});

// -- Rename and delete ------------------------------------------------------

test('a path is a row only directly inside its table with the exact lowercase extension', () => {
	expect(rowStemOf('todos', 'todos/a.b.md')).toBe('a.b');
	expect(rowStemOf('todos', 'todos/.md')).toBe('');
	for (const path of [
		'todos/a.MD',
		'todos/a.Md',
		'todos/a.txt',
		'todos/a/b.md',
		'todos.md',
		'other/a.md',
		'todos2/a.md',
	])
		expect(rowStemOf('todos', path)).toBeUndefined();
});

test('a text capture can rename its row, returns an interpreted snapshot, and refuses a changed baseline', async () => {
	const { table, entry } = await setup();
	const capture = {
		path: entry.path,
		sha256: entry.sha256,
		source: entry.source,
	};
	expect(expectOk(await table.rename(capture, 'a'))).toEqual(entry);
	const changed = expectOk(
		await table.update('a', { fields: { title: 'Outside' } }),
	);
	expect(expectErr(await table.rename(capture, 'named')).name).toBe('Conflict');
	expect(expectOk(await table.get('named'))).toBeUndefined();
	expect(expectOk(await table.get('a'))).toEqual(changed);

	const renamed = expectOk(await table.rename(changed, 'named'));
	expect(renamed).toMatchObject({
		path: 'todos/named.md',
		stem: 'named',
		sha256: changed.sha256,
		source: changed.source,
	});
	expect(readingOf(renamed)).toEqual(readingOf(changed));
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
	expect(expectErr(await table.delete(entry)).name).toBe('NotFound');
	expect(expectOk(await table.list())).toEqual([]);
});

test('a rename refuses a capture whose source is not the text of its hash, before anything is read or moved', async () => {
	const s = await setup();
	const invented = '---\ntitle: Invented\ndone: true\ntags: []\n---\n';
	for (const stem of ['named', 'a']) {
		// A real path and hash beside text that was never in the file.
		const mismatched = expectErr(
			await s.table.rename({ ...s.entry, source: invented }, stem),
		);
		expect(mismatched).toMatchObject({
			name: 'InvalidPath',
			path: 'todos/a.md',
			reason: "the capture's source does not have its SHA-256",
		});
		// Untyped callers can leave the source out altogether.
		const { source: _source, ...bare } = s.entry;
		expect(expectErr(await s.table.rename(bare as never, stem))).toMatchObject({
			name: 'InvalidPath',
			reason: 'the capture has no source',
		});
	}
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });
	expect(expectOk(await s.table.get('named'))).toBeUndefined();
	expect(expectOk(await s.table.get('a'))).toEqual(s.entry);
});

test('a rename reads the text of the captured bytes: an unpaired surrogate is its replacement character', async () => {
	const s = await setup();
	const lone = '---\ntitle: "\ud800"\ndone: false\ntags: []\n---\n';
	const saved = expectOk(await s.table.replace(s.entry, lone));
	expect(saved.source).toBe(lone.replace('\ud800', '�'));

	// The caller's string encodes to the saved bytes, so it names this capture.
	const renamed = expectOk(
		await s.table.rename({ ...saved, source: lone }, 'named'),
	);
	expect(renamed).toEqual({
		...saved,
		path: 'todos/named.md',
		stem: 'named',
	});
	expect(await s.stored('todos/named.md')).toBe(saved.source);
});

// -- Refinements --------------------------------------------------------------

/** What `Type.Refine` adds to a schema, written out: this package does not depend on TypeBox. */
const refined = <TSchema extends object>(
	schema: TSchema,
	refine: (value: unknown) => boolean,
) => ({ ...schema, '~refine': [{ refine, message: 'refused' }] });

const refining = defineFolder({
	kv: {},
	tables: {
		// A refinement may freeze the value it is shown, and only that value.
		frozen: defineTable({
			fields: {
				data: refined({ type: 'object' }, (value) => {
					Object.freeze(value);
					return true;
				}),
			},
		}),
		// A refinement that tries to change the value it is shown.
		mutating: defineTable({
			fields: {
				title: { type: 'string' },
				data: refined({ type: 'object' }, (value) => {
					if (value !== null) (value as { answer: number }).answer = 99;
					return true;
				}),
			},
		}),
		// A refinement that throws on one value and admits every other.
		guarded: defineTable({
			fields: {
				title: { type: 'string' },
				guard: refined({ type: 'string' }, (value) => {
					if (value === 'boom') throw new Error('the refinement threw');
					return true;
				}),
			},
		}),
	},
});

test('a parent its refinement froze still has every child frozen, aliases included', () => {
	const frozen = tableOf<{ data: Record<string, unknown> }>(
		undefined as never,
		refining,
		'frozen',
	);
	const reading = frozen.inspect(
		'---\ndata:\n  list: &shared [1, {deep: [2]}]\n  again: *shared\n---\n',
	);
	expect(reading.issues).toEqual([]);
	const data = reading.fields.data as { list: unknown[]; again: unknown[] };
	expect(data.again).toBe(data.list);
	const nodes = nodesOf(reading);
	expect(nodes.length).toBeGreaterThan(5);
	for (const node of nodes) expect(Object.isFrozen(node)).toBe(true);
	expect(() => data.list.push(3)).toThrow(TypeError);
});

test('a refinement is shown the table’s frozen copy: the supplied objects stay unfrozen, and a class instance is still refused', async () => {
	const s = await setup();
	const frozen = tableOf<{ data: { list: number[] } }>(
		s.storage,
		refining,
		'frozen',
	);
	const supplied = { data: { list: [1] } };
	const created = expectOk(
		await frozen.create({ stem: 'f', fields: supplied }),
	);
	const change = { data: { list: [3] } };
	const updated = expectOk(await frozen.update('f', { fields: change }));
	for (const node of [...nodesOf(supplied), ...nodesOf(change)])
		expect(Object.isFrozen(node)).toBe(false);
	supplied.data.list.push(2);
	change.data.list.push(4);
	expect(created.fields.data).toEqual({ list: [1] });
	expect(updated.fields.data).toEqual({ list: [3] });

	// Copying would flatten this into a plain object the field accepts.
	class Box {
		list = [1];
	}
	const refused = expectErr(
		await frozen.create({ stem: 'g', fields: { data: new Box() } }),
	);
	expect(refused.name).toBe('InvalidValues');
	expect(expectOk(await frozen.get('g'))).toBeUndefined();
});

test('a refinement that changes its value is a field issue: the supplied object, the source, and the other fields stay as they were', async () => {
	const s = await setup();
	const mutating = tableOf<{ title: string; data: { answer: number } }>(
		s.storage,
		refining,
		'mutating',
	);
	const supplied = { title: 'A', data: { answer: 1 } };
	for (const refused of [
		await mutating.create({ stem: 'm', fields: supplied, body: 'notes\n' }),
		await mutating.update('m', { fields: { data: supplied.data } }),
	]) {
		const error = expectErr(refused);
		expect(error.name).toBe('InvalidValues');
		if (error.name !== 'InvalidValues') continue;
		expect(error.issues.map((issue) => issue.field)).toEqual(['data']);
	}
	expect(supplied).toEqual({ title: 'A', data: { answer: 1 } });
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });

	// The same row as a file somebody wrote: it reads with the issue, and the
	// value the refinement was shown is not what the reading reports.
	const source = '---\ntitle: A\ndata: {answer: 1}\n---\nnotes\n';
	await s.put('mutating/m.md', source);
	const row = expectOk(await mutating.get('m'))!;
	expect(row).toMatchObject({
		source,
		fields: { title: 'A' },
		body: 'notes\n',
		parseError: undefined,
	});
	expect(Object.hasOwn(row.fields, 'data')).toBe(false);
	expect(row.issues.map((issue) => issue.field)).toEqual(['data']);
	expect(mutating.inspect(source).fields).toEqual({ title: 'A' });

	// A complete replacement is published as written, with the same issue.
	const next = source.replace('answer: 1', 'answer: 2');
	const replaced = expectOk(await mutating.replace(row, next));
	expect(await s.stored(row.path)).toBe(next);
	expect(replaced.source).toBe(next);
	expect(replaced.issues.map((issue) => issue.field)).toEqual(['data']);

	// Another field updates beside it and leaves its text alone.
	const updated = expectOk(
		await mutating.update('m', { fields: { title: 'B' } }),
	);
	expect(updated.source).toBe(next.replace('title: A', 'title: B'));
	expect(updated.fields).toEqual({ title: 'B' });
});

test('a field whose refinement throws is a field issue: the source is saved, and the other fields and the body still read', async () => {
	const s = await setup();
	const guarded = tableOf<{ title: string; guard: string }>(
		s.storage,
		refining,
		'guarded',
	);
	const row = expectOk(
		await guarded.create({
			stem: 'g',
			fields: { title: 'A', guard: 'ok' },
			body: 'notes\n',
		}),
	);

	// A complete replacement is saved as written, whatever its fields read as.
	const throwing = row.source.replace('guard: ok', 'guard: boom');
	const replaced = expectOk(await guarded.replace(row, throwing));
	expect(await s.stored(row.path)).toBe(throwing);
	expect(replaced).toMatchObject({
		source: throwing,
		fields: { title: 'A' },
		body: 'notes\n',
		parseError: undefined,
	});
	expect(Object.hasOwn(replaced.fields, 'guard')).toBe(false);
	expect(replaced.issues.map((issue) => issue.field)).toEqual(['guard']);
	expect(expectOk(await guarded.get('g'))).toEqual(replaced);

	// An update of another field goes through and leaves the stored text alone.
	const updated = expectOk(
		await guarded.update('g', { fields: { title: 'B' } }),
	);
	expect(updated.source).toBe(throwing.replace('title: A', 'title: B'));
	expect(await s.stored(row.path)).toBe(updated.source);
	expect(updated.fields).toEqual({ title: 'B' });
	expect(updated.issues.map((issue) => issue.field)).toEqual(['guard']);

	// The value itself is still refused as input.
	expect(
		expectErr(await guarded.update('g', { fields: { guard: 'boom' } })).name,
	).toBe('InvalidValues');
	expect(await s.stored(row.path)).toBe(updated.source);
});

test('a receipt is prepared before publication: an interpreter that fails leaves every file as it was', async () => {
	const s = await setup();
	// No declared field does this; it stands for a failure nobody planned for.
	// Interpreting source lists the table's fields, and that listing throws.
	let failing = false;
	const table = createTable<Todo>(
		{ storage: s.storage, onFilesChanged: () => () => {} },
		'todos',
		new Proxy(definition.tables.todos.fields, {
			ownKeys(fields) {
				if (failing) throw new Error('the interpreter failed');
				return Reflect.ownKeys(fields);
			},
		}),
	);
	// A new row's values are checked before anything is read, so its
	// interpreter starts failing at the directory read: after the values
	// passed, before the receipt.
	const { children } = s.storage;
	s.storage.children = (...args) => {
		failing = true;
		return children(...args);
	};
	const fields = { title: 'New', done: false, tags: [] };
	await expect(table.create({ stem: 'b', fields })).rejects.toThrow(
		'the interpreter failed',
	);
	s.storage.children = children;
	expect(failing).toBe(true);
	for (const save of [
		() => table.update('a', { fields: { done: true } }),
		() => table.replace(s.entry, VALID),
		() => table.rename(s.entry, 'moved'),
	])
		await expect(save()).rejects.toThrow('the interpreter failed');
	expect(s.counts().applications).toBe(0);
	expect(await s.stored()).toBe(s.entry.source);
	failing = false;
	expect(expectOk(await table.list()).map((item) => item.path)).toEqual([
		'todos/a.md',
	]);
	// The capture is still the baseline: nothing was saved under it.
	expect(expectOk(await table.replace(s.entry, VALID)).source).toBe(VALID);
});

test('a receipt source is decoded from the submitted bytes: a byte-order mark, CRLF, and paired surrogates are kept', async () => {
	const s = await setup();
	const exact =
		'﻿---\r\ntitle: "\u{1F600} café"\r\ndone: false\r\ntags: []\r\n---\r\nbody\r\n';
	const saved = expectOk(await s.table.replace(s.entry, exact));
	expect(saved.source).toBe(exact);
	expect(saved.sha256).toBe(await hashBytes(encoder.encode(exact)));
	expect(await s.stored()).toBe(exact);
	expect(expectOk(await s.table.get('a'))).toEqual(saved);
	// The same capture renames: its source is the text of its hash.
	const renamed = expectOk(await s.table.rename(saved, 'named'));
	expect(renamed.source).toBe(exact);
});
