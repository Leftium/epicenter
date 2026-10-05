/**
 * File Table Tests
 *
 * Exercises browser OPFS publication, over the in-memory stand-in, with
 * competing writes at the boundary.
 * A table captures a row file first and interprets its text second, so these
 * tests keep three things apart: whether a file was read, whether its text
 * parses, and whether its fields conform.
 *
 * Key behaviors:
 * - A snapshot is the captured file beside its flat reading: a parse failure
 *   leaves no fields, body, or issues; parsed text keeps every field that
 *   validated beside the issues of the rest, and `fields` stays partial
 * - `inspectRow` is the one interpreter, from the definition and no open
 *   folder: reads, receipts, and drafts agree, and it supplies no default and
 *   coerces nothing
 * - `serializeRow` previews the text `create` writes for draft values, before
 *   any folder is open; values that do not conform are written and inspect as
 *   issues, and only what no row could hold is refused. A reading lacks
 *   unknown metadata, so serializing it is not a rewrite; patching is
 * - Interpreted values and diagnostics are frozen at every depth; supplied
 *   values are copied and the caller's objects are left as they were
 * - A field's refinement is shown only the table's own frozen value, parsed
 *   or copied: one that changes it is a field issue and changes nothing
 * - A YAML value that is not JSON is an issue under a declared field and
 *   untouched under an undeclared key; neither stops the rest from reading
 * - A write receipt is `{ stem, path, text, sha256 }` and nothing else: its
 *   text is that of the whole file's bytes submitted, never the objects or
 *   the string the caller passed, and `inspectRow` of it is what a read
 *   returns
 * - `get` is `undefined` only for absence; `list` has one item per `.md` file
 *   with its own Result, and an outer error only when the listing failed
 * - Every literal single-segment stem is an address, the empty one included;
 *   only the exact lowercase `.md` extension is a row
 * - An occupied destination is the file `Exists` error; names are never
 *   folded, so a differently cased name is a different file here
 * - Every mutation is addressed by stem and takes required options: `{}` is
 *   the current row and `expectedSha256` a byte condition. Absent options and
 *   any other key are refused before anything is read; a wrapper that
 *   forwards its options keeps a stale guard; nothing retries
 * - Updates validate input, read once, check the caller's baseline against
 *   that read, require the source to parse, patch only assigned spans, and
 *   publish once against their own read; they never rewrite on a refusal
 * - Replacement saves exact text, malformed included, reads nothing, and
 *   requires an existing row even without a baseline
 * - Rename moves to a vacant stem and reads nothing for a reply; a rename to
 *   its own stem is InvalidPath before storage; delete removes, and absence
 *   is NotFound, guarded or not
 *
 * See also:
 * - `markdown.test.ts` for framing, YAML, and patch refusals
 * - `native.test.ts` for the same table over a real directory
 */
import { expect, test } from 'bun:test';
import { type DataSchema, jsonValue } from '@epicenter/definition';
import type { Result } from 'wellcrafted/result';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { rawBrowserFolder } from './browser-storage.test-support.js';
import { hashBytes } from './capture.js';
import {
	type CreateRowOf,
	defineFolder,
	defineTable,
	field,
	inspectRow,
	type PreparedFolderTable,
	serializeRow,
} from './contract.js';
import {
	ApplyError,
	FileError,
	MoveError,
	TableError,
	type TableWriteError,
} from './errors.js';
import { patchRowText } from './markdown.js';
import { rowPath, rowStemOf } from './paths.js';
import {
	createTable,
	type TableSnapshot,
	type TableWriteOptions,
	type TableWriteReceipt,
} from './table.js';

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
		{ storage },
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

/** A write receipt with its text interpreted: what a read of those bytes returns. */
const interpreted = <const TTable extends PreparedFolderTable>(
	table: TTable,
	receipt: TableWriteReceipt,
): TableSnapshot<CreateRowOf<TTable>> => ({
	...receipt,
	...inspectRow(table, receipt.text),
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

async function setup() {
	const base = (await rawBrowserFolder({ id: 'table.commands' })).boundary;
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
	expectOk(
		await table.create({
			stem: 'a',
			fields: { title: 'A', done: false, tags: [] },
			body: 'body\n',
		}),
	);
	const entry = expectOk(await table.get('a'))!;
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
		text: '---\ntitle: A\ndone: false\ntags: []\n---\nbody\n',
		sha256: await hashBytes(encoder.encode(entry.text)),
		fields: { title: 'A', done: false, tags: [] },
		body: 'body\n',
		parseError: undefined,
		issues: [],
	});
	// A read, a receipt, and a draft are interpreted by the same function.
	expect(expectOk(await table.get('a'))).toEqual(entry);
	const draft = inspectRow(definition.tables.todos, entry.text);
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
		text: MALFORMED,
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
	const unknown = inspectRow(
		definition.tables.todos,
		'---\ntitle: A\ndone: false\ntags: []\nextra: {a: 1}\n---\n',
	);
	expect(unknown.issues).toEqual([]);
	expect(unknown.fields).toEqual({ title: 'A', done: false, tags: [] });

	const partial = inspectRow(
		definition.tables.todos,
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
	const missing = inspectRow(definition.tables.todos, '---\n---\n');
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
		const reading = inspectRow(definition.tables.todos, source);
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
	const absent = inspectRow(definition.tables.dated, '---\n---\n');
	expect(absent.fields).toEqual({});
	expect(absent.issues.map((issue) => issue.field)).toEqual(['due', 'label']);

	// A stored null is a value; the key not being there is not.
	const stored = inspectRow(definition.tables.dated, '---\ndue: null\n---\n');
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
	const reading = inspectRow(definition.tables.todos, source);
	expect(reading.parseError).toBeUndefined();
	expect(reading.fields).toEqual({ title: 'usable' });
	expect(reading.body).toBe('body\n');
	expect(reading.issues.map((issue) => issue.field).sort()).toEqual([
		'done',
		'tags',
	]);
	for (const node of nodesOf(reading)) expect(Object.isFrozen(node)).toBe(true);

	// A declared field that accepts any JSON still refuses bytes inside it.
	const nested = inspectRow(
		definition.tables.loose,
		'---\ndata: {bytes: !!binary SGVsbG8=}\n---\n',
	);
	expect(nested.fields).toEqual({});
	expect(nested.issues.map((issue) => issue.field)).toEqual(['data']);

	// A complete replacement is published as written, and reads the same way
	// from its receipt, a get, and a listing.
	const replaced = expectOk(await s.table.replace('a', source, {}));
	expect(await s.stored()).toBe(source);
	expect(replaced.text).toBe(source);
	expect(readingOf(interpreted(definition.tables.todos, replaced))).toEqual(
		reading,
	);
	expect(expectOk(await s.table.get('a'))).toEqual(
		interpreted(definition.tables.todos, replaced),
	);
	const [listed] = expectOk(await s.table.list());
	expect(expectOk(listed!.result)).toEqual(
		interpreted(definition.tables.todos, replaced),
	);

	// The field beside them updates, and their text stays as written.
	const updated = expectOk(
		await s.table.update('a', { fields: { title: 'still usable' } }, {}),
	);
	expect(updated.text).toBe(
		source.replace('title: usable', 'title: still usable'),
	);
	expect(inspectRow(definition.tables.todos, updated.text).fields).toEqual({
		title: 'still usable',
	});
});

test('a reading is frozen at every depth, parse errors and issues included', () => {
	// The alias makes one parsed node reachable from two places.
	const nested = inspectRow(
		definition.tables.loose,
		'---\ndata:\n  list: &shared [1, {deep: [2]}]\n  again: *shared\n---\n',
	);
	expect(nested.fields).toEqual({
		data: { list: [1, { deep: [2] }], again: [1, { deep: [2] }] },
	});
	for (const reading of [
		nested,
		inspectRow(definition.tables.todos, '---\ntitle: A\ntags: [a, 3]\n---\n'),
		inspectRow(definition.tables.todos, MALFORMED),
	]) {
		const nodes = nodesOf(reading);
		expect(nodes.length).toBeGreaterThan(3);
		for (const node of nodes) expect(Object.isFrozen(node)).toBe(true);
	}
	const data = nested.fields.data as { list: unknown[] };
	expect(() => data.list.push(3)).toThrow(TypeError);

	// Two readings of one source share nothing a caller could change.
	const again = inspectRow(
		definition.tables.todos,
		'---\ntitle: A\ndone: false\ntags: [a]\n---\n',
	);
	const other = inspectRow(
		definition.tables.todos,
		'---\ntitle: A\ndone: false\ntags: [a]\n---\n',
	);
	expect(again.fields.tags).toEqual(other.fields.tags);
	expect(again.fields.tags).not.toBe(other.fields.tags);
});

test('supplied values are copied: the caller keeps mutable objects, and a receipt holds none of them', async () => {
	const s = await setup();
	const tags = ['one'];
	const fields = { title: 'B', done: false, tags };
	const receipt = expectOk(await s.table.create({ stem: 'b', fields }));
	expect(Object.isFrozen(fields)).toBe(false);
	expect(Object.isFrozen(tags)).toBe(false);
	// A receipt names the submitted bytes and holds no supplied object.
	expect(Object.keys(receipt).sort()).toEqual([
		'path',
		'sha256',
		'stem',
		'text',
	]);
	expect(Object.isFrozen(receipt)).toBe(true);
	// The caller's later change reaches neither the receipt nor the file.
	tags.push('later');
	const created = expectOk(await s.table.get('b'))!;
	expect(created).toEqual(interpreted(definition.tables.todos, receipt));
	expect(created.fields.tags).toEqual(['one']);

	// Frozen snapshot values go back in as they are, and come out as new copies.
	expectOk(
		await s.table.update('a', { fields: created.fields, body: 'next\n' }, {}),
	);
	const updated = expectOk(await s.table.get('a'))!;
	expect(updated.fields).toEqual(created.fields);
	expect(updated.fields.tags).not.toBe(created.fields.tags);
	expect(Object.isFrozen(updated.fields.tags)).toBe(true);
	const change = { fields: { tags: ['two'] } };
	expectOk(await s.table.update('a', change, {}));
	expect(Object.isFrozen(change.fields.tags)).toBe(false);
});

test('a receipt reads the text of the submitted bytes, not the string that was passed', async () => {
	const s = await setup();
	// Encoding replaces an unpaired surrogate, so the bytes say U+FFFD.
	const passed = '---\ntitle: "lone \ud800"\ndone: false\ntags: []\n---\n';
	const saved = passed.replace('\ud800', '�');
	const receipt = expectOk(await s.table.replace('a', passed, {}));
	expect(receipt).toEqual({
		stem: 'a',
		path: 'todos/a.md',
		text: saved,
		sha256: await hashBytes(encoder.encode(passed)),
	});
	expect(inspectRow(definition.tables.todos, receipt.text).fields.title).toBe(
		'lone �',
	);
	// The receipt is what a read of those bytes returns, with no read made.
	expect(s.counts().reads).toBe(0);
	expect(expectOk(await s.table.get('a'))).toEqual(
		interpreted(definition.tables.todos, receipt),
	);

	// Every write receipt decodes its own submitted bytes the same way.
	const created = expectOk(
		await s.table.create({
			stem: 'lone',
			fields: { title: 'lone', done: false, tags: [] },
			body: 'lone \ud800\n',
		}),
	);
	expect(created.text.endsWith('lone �\n')).toBe(true);
	expect(expectOk(await s.table.get('lone'))?.text).toBe(created.text);
	const updated = expectOk(
		await s.table.update('a', { body: 'body \udc00\n' }, {}),
	);
	expect(updated.text.endsWith('body �\n')).toBe(true);
	expect(updated.sha256).toBe(await hashBytes(encoder.encode(updated.text)));
	expect(await s.stored()).toBe(updated.text);
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
	expect(broken.text).toBe(MALFORMED);
	expect(readingOf(broken)).toEqual(
		inspectRow(definition.tables.todos, MALFORMED),
	);
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
	// The `UPPER` stem addresses `todos/UPPER.md`, which is not there.
	expect(expectErr(await s.table.replace('UPPER', VALID, {})).name).toBe(
		'NotFound',
	);
	expect(expectErr(await s.table.delete('UPPER', {})).name).toBe('NotFound');
	expect(expectOk(await s.base.read('todos/UPPER.MD'))).toEqual(upper);
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
		expect(inspectRow(definition.tables.todos, created.text)).toMatchObject({
			parseError: undefined,
			issues: [],
		});
		expect(expectOk(await s.table.get(stem))).toEqual(
			interpreted(definition.tables.todos, created),
		);
		const updated = expectOk(
			await s.table.update(stem, { fields: { done: true } }, {}),
		);
		expect(updated.stem).toBe(stem);
		expect(inspectRow(definition.tables.todos, updated.text).fields.done).toBe(
			true,
		);
	}
	const listed = expectOk(await s.table.list()).map(
		(item) => expectOk(item.result).stem,
	);
	expect(listed.sort()).toEqual([...stems, 'a'].sort());

	// Renaming to and from odd names is an ordinary move.
	const empty = expectOk(await s.table.get(''))!;
	expect(expectOk(await s.table.rename('', 'named', {}))).toBeUndefined();
	expect(expectOk(await s.table.get('named'))).toMatchObject({
		path: 'todos/named.md',
		stem: 'named',
		text: empty.text,
	});
	expect(expectOk(await s.table.get(''))).toBeUndefined();
	expectOk(await s.table.rename('named', ' trailing. ', {}));
	expect(expectOk(await s.table.get(' trailing. '))?.path).toBe(
		'todos/ trailing. .md',
	);
	expectOk(await s.table.delete(' trailing. ', {}));
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
		expect(expectErr(await s.table.update(stem, { body: 'x' }, {})).name).toBe(
			'InvalidPath',
		);
		expect(expectErr(await s.table.replace(stem, VALID, {})).name).toBe(
			'InvalidPath',
		);
		expect(expectErr(await s.table.rename('a', stem, {})).name).toBe(
			'InvalidPath',
		);
		expect(expectErr(await s.table.rename(stem, 'b', {})).name).toBe(
			'InvalidPath',
		);
		expect(expectErr(await s.table.delete(stem, {})).name).toBe('InvalidPath');
	}
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });
});

test('an occupied destination is the file Exists error, and a differently spelled name is another file', async () => {
	const s = await setup();
	const fields = { title: 'New', done: false, tags: [] };
	const occupied = expectErr(await s.table.create({ stem: 'a', fields }));
	expect(occupied).toMatchObject({ name: 'Exists', path: 'todos/a.md' });
	expect(await s.stored()).toBe(s.entry.text);

	// This storage keeps names exactly, so no case or Unicode folding applies.
	const upper = expectOk(await s.table.create({ stem: 'A', fields }));
	const composed = expectOk(await s.table.create({ stem: 'é', fields }));
	const decomposed = expectOk(await s.table.create({ stem: 'é', fields }));
	expect(new Set([upper.path, composed.path, decomposed.path]).size).toBe(3);
	expect(expectOk(await s.table.get('a'))).toEqual(s.entry);

	const refused = expectErr(await s.table.rename('A', 'a', {}));
	expect(refused).toMatchObject({ name: 'Exists', path: 'todos/a.md' });
	expect(expectOk(await s.table.get('A'))).toEqual(
		interpreted(definition.tables.todos, upper),
	);
	expect(expectOk(await s.table.get('a'))).toEqual(s.entry);
});

// -- Create -----------------------------------------------------------------

test('a new row always has both fences, even with no fields and no body', async () => {
	const s = await setup();
	const bare = tableOf<Record<string, never>>(s.base, definition, 'bare');
	const created = expectOk(await bare.create({ stem: 'empty', fields: {} }));
	expect(created.text).toBe('---\n---\n');
	expect(inspectRow(definition.tables.bare, created.text)).toEqual({
		body: '',
		fields: {},
		parseError: undefined,
		issues: [],
	});
	expect(expectOk(await bare.get('empty'))).toEqual(
		interpreted(definition.tables.bare, created),
	);
	// The body alone would not parse; the fences are what make it a row.
	expect(
		expectOk(await bare.create({ stem: 'text', fields: {}, body: 'Hi\n' }))
			.text,
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
		await s.table.update('a', { fields: { done: 'wrong' as never } }, {}),
		await s.table.update('a', { fields: { other: 1 } as never }, {}),
		// The field accepts any value; these cannot be copied or written.
		await loose.create({ stem: 'b', fields: { data: () => {} } }),
		await loose.create({ stem: 'b', fields: { data: Number.NaN } }),
		await loose.update('b', { fields: { data: { at: undefined } } }, {}),
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
		await s.table.update(
			'a',
			{
				fields: JSON.parse('{"title": "B", "__proto__": {"extra": 1}}'),
			},
			{},
		),
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
	expect(await s.stored()).toBe(s.entry.text);
});

// -- Pure preview and interpretation ------------------------------------------

test('a preview is the text create writes, made from the definition before any folder is open', async () => {
	// No storage exists yet: only the prepared definition.
	const fields = { title: 'Milk', done: false, tags: ['a'] };
	const preview = expectOk(
		serializeRow(definition.tables.todos, { fields, body: 'notes\n' }),
	);
	expect(preview).toBe(
		'---\ntitle: Milk\ndone: false\ntags: ["a"]\n---\nnotes\n',
	);
	expect(inspectRow(definition.tables.todos, preview)).toEqual({
		fields,
		body: 'notes\n',
		parseError: undefined,
		issues: [],
	});
	// Declared order wins over the order the draft names its keys in.
	expect(
		expectOk(
			serializeRow(definition.tables.todos, {
				fields: { tags: [], done: true, title: 'T' },
			}),
		),
	).toBe('---\ntitle: T\ndone: true\ntags: []\n---\n');

	const s = await setup();
	const created = expectOk(
		await s.table.create({ stem: 'p', fields, body: 'notes\n' }),
	);
	expect(created.text).toBe(preview);
	expect(s.counts().reads).toBe(0);
});

test('a preview writes draft values that do not conform, which inspect as issues; create still refuses them', async () => {
	const draft = {
		fields: { title: 'Milk', done: 'maybe', tags: [1] },
		body: 'b',
	};
	const preview = expectOk(serializeRow(definition.tables.todos, draft));
	expect(preview).toBe('---\ntitle: Milk\ndone: maybe\ntags: [1]\n---\nb');
	const reading = inspectRow(definition.tables.todos, preview);
	expect(reading.fields).toEqual({ title: 'Milk' });
	expect(reading.issues.map((issue) => issue.field)).toEqual(['done', 'tags']);

	// A field the draft leaves out, or leaves undefined, is absent and an issue.
	const partial = expectOk(
		serializeRow(definition.tables.todos, {
			fields: { title: 'Only', done: undefined },
		}),
	);
	expect(partial).toBe('---\ntitle: Only\n---\n');
	expect(
		inspectRow(definition.tables.todos, partial).issues.map(
			(issue) => issue.field,
		),
	).toEqual(['done', 'tags']);

	// What no row could hold is refused, every problem at once.
	const refused = expectErr(
		serializeRow(definition.tables.loose, {
			fields: { data: Number.NaN, other: 1 } as never,
		}),
	);
	expect(refused.name).toBe('InvalidValues');
	expect(refused.issues.map((issue) => issue.field).sort()).toEqual([
		'data',
		'other',
	]);
	expect(
		expectErr(
			serializeRow(definition.tables.loose, { fields: { data: new Date(0) } }),
		).issues.map((issue) => issue.field),
	).toEqual(['data']);

	const s = await setup();
	expect(
		expectErr(
			await s.table.create({ stem: 'p', fields: draft.fields as never }),
		).name,
	).toBe('InvalidValues');
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });
});

test('a preview is the text of its UTF-8 bytes: an unpaired surrogate in the body is U+FFFD, a byte-order mark and CRLF stay', async () => {
	// YAML escapes the field's lone surrogate, so it reads back as supplied.
	const fields = { title: 'lone \ud800', done: false, tags: [] };
	const body = '\uFEFFfirst \udc00\r\nsecond\r\n';
	const preview = expectOk(
		serializeRow(definition.tables.todos, { fields, body }),
	);
	expect(preview).toBe(
		'---\r\ntitle: "lone \\ud800"\r\ndone: false\r\ntags: []\r\n---\r\n\uFEFFfirst \uFFFD\r\nsecond\r\n',
	);
	const reading = inspectRow(definition.tables.todos, preview);
	expect(reading.fields.title).toBe('lone \ud800');
	expect(reading.body).toBe('\uFEFFfirst \uFFFD\r\nsecond\r\n');

	const s = await setup();
	const created = expectOk(await s.table.create({ stem: 'u', fields, body }));
	expect(created.text).toBe(preview);
	expect(created.sha256).toBe(await hashBytes(encoder.encode(preview)));
	expect(await s.stored(created.path)).toBe(preview);
});

test('a reading leaves out unknown metadata, so serializing it is not a rewrite: patching keeps the file', async () => {
	const existing = [
		'---',
		'# kept comment',
		'title: Old',
		'done: false',
		'tags: []',
		'extra: {a: 1}',
		'---',
		'body\n',
	].join('\n');
	const reading = inspectRow(definition.tables.todos, existing);
	expect(reading.fields).toEqual({ title: 'Old', done: false, tags: [] });
	expect(reading.issues).toEqual([]);

	// Writing the reading back loses what the reading never held.
	const rewritten = expectOk(
		serializeRow(definition.tables.todos, {
			fields: { ...reading.fields, title: 'New' },
			body: reading.body,
		}),
	);
	expect(rewritten).not.toContain('extra');
	expect(rewritten).not.toContain('# kept comment');

	// A patch of the exact text changes the one value and keeps the rest.
	const patched = expectOk(
		patchRowText(existing, { fields: { title: 'New' } }),
	);
	expect(patched).toBe(existing.replace('title: Old', 'title: New'));

	// So does the table's own update of the stored file.
	const s = await setup();
	await s.overwrite(existing);
	const updated = expectOk(
		await s.table.update('a', { fields: { title: 'New' } }, {}),
	);
	expect(updated.text).toBe(patched);
});

// -- Update -----------------------------------------------------------------

test('a command patches current source and preserves formatting and unrelated changes', async () => {
	const s = await setup();
	const current =
		'﻿---\r\n# kept\r\ntitle: "Newer"\r\ndone: false\r\ntags: []\r\nunknown: 3\r\n---\r\nnew body\r\n';
	await s.overwrite(current);
	const next = expectOk(
		await s.table.update('a', { fields: { done: true } }, {}),
	);
	expect(next.text).toBe(current.replace('done: false', 'done: true'));
	expect(inspectRow(definition.tables.todos, next.text).fields.title).toBe(
		'Newer',
	);
	expect(await s.stored()).toBe(next.text);
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
			const error = expectErr(await s.table.update('a', change, {}));
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
		await s.table.update('a', { fields: { title: 'B' } }, {}),
	);
	expect(error.name).toBe('UnsupportedSource');
	expect(await s.stored()).toBe(source);
	expect(s.counts()).toEqual({ reads: 1, applications: 0 });
	// A span the patch can replace is still assignable in the same file.
	const next = expectOk(
		await s.table.update('a', { fields: { done: true } }, {}),
	);
	expect(next.text).toBe(source.replace('done: false', 'done: true'));
});

test('issues in fields the update does not assign do not block it', async () => {
	const s = await setup();
	const source = '---\ntitle: 12\ntags: nope\ndone: false\n---\nbody\n';
	await s.overwrite(source);
	const next = expectOk(
		await s.table.update('a', { fields: { done: true } }, {}),
	);
	expect(next.text).toBe(source.replace('done: false', 'done: true'));
	const reading = inspectRow(definition.tables.todos, next.text);
	expect(reading.fields).toEqual({ done: true });
	expect(reading.issues.map((issue) => issue.field)).toEqual(['title', 'tags']);
});

test('a race returns Conflict after one attempt and leaves the competing bytes', async () => {
	const s = await setup();
	const external = s.entry.text.replace('title: A', 'title: External');
	s.beforeApply(() => s.overwrite(external));
	const error = expectErr(
		await s.table.update('a', { fields: { done: true } }, {}),
	);
	expect(error.name).toBe('Conflict');
	expect(s.counts()).toEqual({ reads: 1, applications: 1 });
	expect(await s.stored()).toBe(external);
});

test('a missing or concurrently removed row is never recreated', async () => {
	const s = await setup();
	expect(
		expectErr(await s.table.update('missing', { body: 'draft' }, {})).name,
	).toBe('NotFound');
	expect(s.counts()).toEqual({ reads: 1, applications: 0 });
	s.beforeApply(async () => {
		expectOk(
			await s.base.apply([
				{ kind: 'remove', path: s.entry.path, expectedSha256: s.entry.sha256 },
			]),
		);
	});
	const error = expectErr(await s.table.update('a', { body: 'draft' }, {}));
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
	const next = inspectRow(
		definition.tables.todos,
		expectOk(await s.table.update('a', change, {})).text,
	);
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
		expectErr(await s.table.update('a', { fields: { done: true } }, {})).name,
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

// -- Caller baselines -------------------------------------------------------

test('a caller baseline on update is checked against the one read, and the save is always conditional on that read', async () => {
	const s = await setup();
	// A matching baseline patches the current text.
	const next = expectOk(
		await s.table.update(
			'a',
			{ fields: { done: true } },
			{ expectedSha256: s.entry.sha256 },
		),
	);
	expect(next.text).toBe(s.entry.text.replace('done: false', 'done: true'));
	expect(s.counts()).toEqual({ reads: 1, applications: 1 });

	// A stale baseline is refused after the read, before anything is prepared.
	const stale = expectErr(
		await s.table.update(
			'a',
			{ fields: { title: 'Late' } },
			{ expectedSha256: s.entry.sha256 },
		),
	);
	expect(stale).toEqual(
		FileError.Conflict({
			path: 'todos/a.md',
			expectedSha256: s.entry.sha256,
			actualSha256: next.sha256,
		}).error,
	);
	expect(s.counts()).toEqual({ reads: 2, applications: 1 });
	expect(await s.stored()).toBe(next.text);

	// An absent row does not have the caller's bytes: a Conflict, not a
	// creation. Without a baseline it is NotFound.
	expect(
		expectErr(
			await s.table.update(
				'missing',
				{ body: 'x' },
				{ expectedSha256: s.entry.sha256 },
			),
		),
	).toMatchObject({ name: 'Conflict', actualSha256: undefined });
	expect(expectOk(await s.table.get('missing'))).toBeUndefined();

	// A writer that lands after the read is refused at publication, once.
	const external = next.text.replace('title: A', 'title: External');
	s.beforeApply(() => s.overwrite(external));
	const raced = expectErr(
		await s.table.update(
			'a',
			{ fields: { done: false } },
			{ expectedSha256: next.sha256 },
		),
	);
	expect(raced).toMatchObject({
		name: 'Conflict',
		expectedSha256: next.sha256,
		actualSha256: await hashBytes(encoder.encode(external)),
	});
	expect(await s.stored()).toBe(external);
});

test('an expectedSha256 that is not a lowercase SHA-256 is refused before anything is read or written, and the option is read once', async () => {
	const s = await setup();
	for (const expectedSha256 of [
		'abc',
		s.entry.sha256.toUpperCase(),
		42,
		null,
	] as never[]) {
		const options = { expectedSha256 };
		const refusals: Result<unknown, TableWriteError>[] = [
			await s.table.update('a', { body: 'x' }, options),
			await s.table.replace('a', VALID, options),
			await s.table.rename('a', 'b', options),
			await s.table.rename('a', 'a', options),
			await s.table.delete('a', options),
		];
		for (const refused of refusals)
			expect(expectErr(refused)).toMatchObject({
				name: 'InvalidPath',
				path: 'todos/a.md',
				reason: 'expectedSha256 is not a lowercase SHA-256',
			});
	}
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });

	// A getter is asked once, when the method is entered; later answers do
	// not change the condition the save publishes under.
	let asked = 0;
	const options = {
		get expectedSha256() {
			asked++;
			return asked === 1 ? s.entry.sha256 : 'f'.repeat(64);
		},
	};
	expectOk(await s.table.replace('a', VALID, options));
	expect(asked).toBe(1);
	expect(await s.stored()).toBe(VALID);
});

test('write options are required and hold only the guard: anything else is refused before anything is read or written', async () => {
	const s = await setup();
	const snapshot = s.entry;
	const cases: [options: unknown, reason: string][] = [
		[undefined, 'Write options are required'],
		[null, 'Write options are required'],
		['a'.repeat(64), 'Write options are required'],
		[[], 'Write options are required'],
		// A misspelled guard would otherwise publish unguarded.
		[{ expectedSHA256: snapshot.sha256 }, "not 'expectedSHA256'"],
		// So would a snapshot passed where options go.
		[snapshot, "not 'path'"],
	];
	for (const [options, reason] of cases) {
		const loose = options as never;
		const refusals: Result<unknown, TableWriteError>[] = [
			await s.table.update('a', { body: 'x' }, loose),
			await s.table.replace('a', VALID, loose),
			await s.table.rename('a', 'b', loose),
			await s.table.delete('a', loose),
		];
		for (const refused of refusals)
			expect(expectErr(refused)).toMatchObject({
				name: 'InvalidPath',
				path: 'todos/a.md',
				reason: expect.stringContaining(reason),
			});
	}
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });
	expect(await s.stored()).toBe(snapshot.text);

	// The address is still checked first, as it always was.
	expect(
		expectErr(await s.table.delete('a/b', undefined as never)),
	).toMatchObject({ name: 'InvalidPath', path: 'todos/a/b.md' });

	// `{}` is the current row.
	expectOk(await s.table.update('a', { body: 'y' }, {}));
	expect(await s.stored()).toBe(snapshot.text.replace('body\n', 'y'));
});

test('an expectedSha256 that is present but undefined is refused before anything is read or written, however it is present', async () => {
	const s = await setup();
	const snapshot = s.entry;
	let asked = 0;
	const present: [label: string, options: () => TableWriteOptions][] = [
		// What `{ expectedSha256: snapshot?.sha256 }` makes with no snapshot.
		['own', () => ({ expectedSha256: undefined })],
		[
			'getter',
			() => ({
				get expectedSha256() {
					asked++;
					return undefined;
				},
			}),
		],
		['inherited', () => Object.create({ expectedSha256: undefined })],
		[
			'not enumerable',
			() =>
				Object.defineProperty({}, 'expectedSha256', {
					value: undefined,
					enumerable: false,
				}),
		],
	];
	for (const [label, options] of present) {
		const refusals: [string, Result<unknown, TableWriteError>][] = [
			['update', await s.table.update('a', { body: 'x' }, options())],
			['replace', await s.table.replace('a', VALID, options())],
			['rename', await s.table.rename('a', 'b', options())],
			['delete', await s.table.delete('a', options())],
			// A missing row is refused the same way, not as NotFound or Conflict.
			['missing', await s.table.update('missing', { body: 'x' }, options())],
		];
		for (const [operation, refused] of refusals)
			expect({ label, operation, error: expectErr(refused) }).toMatchObject({
				error: {
					name: 'InvalidPath',
					reason: expect.stringContaining('present but undefined'),
				},
			});
	}
	// The getter was read once per call.
	expect(asked).toBe(5);
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });
	expect(await s.stored()).toBe(snapshot.text);
	expect(expectOk(await s.table.get('b'))).toBeUndefined();

	// An inherited guard that is present is a guard: a stale one is Conflict.
	await s.overwrite(snapshot.text.replace('body\n', 'their body\n'));
	expect(
		expectErr(
			await s.table.delete(
				'a',
				Object.create({ expectedSha256: snapshot.sha256 }),
			),
		).name,
	).toBe('Conflict');
	expect(await s.stored()).toBe(
		snapshot.text.replace('body\n', 'their body\n'),
	);
});

test('a wrapper that forwards the options it receives keeps a stale guard: each mutation is Conflict and the newer bytes stay', async () => {
	const s = await setup();
	const reviewed = s.entry;
	const writes: string[] = [];
	// The shape of an application wrapper: it adds work and passes the
	// caller's options through.
	const wrapped: typeof s.table = {
		...s.table,
		update: (stem, change, options) => {
			writes.push(`update ${stem}`);
			return s.table.update(stem, change, options);
		},
		replace: (stem, text, options) => {
			writes.push(`replace ${stem}`);
			return s.table.replace(stem, text, options);
		},
		rename: (stem, nextStem, options) => {
			writes.push(`rename ${stem}`);
			return s.table.rename(stem, nextStem, options);
		},
		delete: (stem, options) => {
			writes.push(`delete ${stem}`);
			return s.table.delete(stem, options);
		},
	};
	// Someone else edits the body after the caller reviewed the row.
	const external = reviewed.text.replace('body\n', 'their body\n');
	await s.overwrite(external);
	const guard = { expectedSha256: reviewed.sha256 };
	const refusals: Result<unknown, TableWriteError>[] = [
		await wrapped.update('a', { fields: { title: 'From old body' } }, guard),
		await wrapped.replace('a', VALID, guard),
		await wrapped.rename('a', 'b', guard),
		await wrapped.delete('a', guard),
	];
	expect(writes).toEqual(['update a', 'replace a', 'rename a', 'delete a']);
	for (const refused of refusals)
		expect(expectErr(refused)).toMatchObject({
			name: 'Conflict',
			expectedSha256: reviewed.sha256,
			actualSha256: await hashBytes(encoder.encode(external)),
		});
	expect(await s.stored()).toBe(external);
	expect(expectOk(await s.table.get('b'))).toBeUndefined();
});

test('a field derived from reviewed bytes needs the caller’s guard: the update’s own read does not stand in for it', async () => {
	const s = await setup();
	const reviewed = s.entry;
	// The caller derives a title from the body it reviewed; then the body changes.
	const derived = { fields: { title: 'From the reviewed body' } };
	const external = reviewed.text.replace('body\n', 'their body\n');
	await s.overwrite(external);

	expect(
		expectErr(
			await s.table.update('a', derived, { expectedSha256: reviewed.sha256 }),
		).name,
	).toBe('Conflict');
	expect(await s.stored()).toBe(external);

	// `{}` publishes against the update's own read, which is the newer body: it
	// lands, with a title nobody derived from that body.
	expectOk(await s.table.update('a', derived, {}));
	expect(await s.stored()).toBe(
		external.replace(/title: .*/, 'title: From the reviewed body'),
	);
});

// -- Replace ----------------------------------------------------------------

test('replacement saves malformed text exactly and returns the submitted receipt without reading', async () => {
	const s = await setup();
	s.afterApply(() => s.overwrite('another writer'));
	const next = expectOk(await s.table.replace('a', MALFORMED, {}));
	// The save succeeded; how the text reads is the caller's to inspect.
	expect(next).toEqual({
		stem: 'a',
		path: s.entry.path,
		text: MALFORMED,
		sha256: await hashBytes(encoder.encode(MALFORMED)),
	});
	expect(
		inspectRow(definition.tables.todos, next.text).parseError,
	).toBeDefined();
	expect(s.counts()).toEqual({ reads: 0, applications: 1 });
	expect(await s.stored()).toBe('another writer');
	// A receipt's hash is a baseline for the bytes it submitted, not the
	// later writer's.
	expect(
		expectErr(
			await s.table.replace('a', 'retry draft', {
				expectedSha256: next.sha256,
			}),
		).name,
	).toBe('Conflict');
	expect(await s.stored()).toBe('another writer');
});

test('a replacement never creates a row, guarded or not, and a concurrently removed row stays removed', async () => {
	const s = await setup();
	expect(expectErr(await s.table.replace('missing', VALID, {}))).toMatchObject({
		name: 'NotFound',
		path: 'todos/missing.md',
	});
	expect(
		expectErr(
			await s.table.replace('missing', VALID, {
				expectedSha256: s.entry.sha256,
			}),
		),
	).toMatchObject({ name: 'Conflict', actualSha256: undefined });
	expect(s.counts().reads).toBe(0);
	expect(expectOk(await s.table.get('missing'))).toBeUndefined();

	s.beforeApply(async () => {
		expectOk(
			await s.base.apply([
				{ kind: 'remove', path: s.entry.path, expectedSha256: s.entry.sha256 },
			]),
		);
	});
	expect(expectErr(await s.table.replace('a', VALID, {})).name).toBe(
		'NotFound',
	);
	expect(expectErr(await s.base.read(s.entry.path)).name).toBe('NotFound');
});

test('a stale baseline conflicts once and changes nothing', async () => {
	const s = await setup();
	const external = s.entry.text.replace('title: A', 'title: External');
	await s.overwrite(external);
	const error = expectErr(
		await s.table.replace('a', MALFORMED, { expectedSha256: s.entry.sha256 }),
	);
	expect(error).toMatchObject({
		name: 'Conflict',
		expectedSha256: s.entry.sha256,
		actualSha256: await hashBytes(encoder.encode(external)),
	});
	expect(s.counts()).toEqual({ reads: 0, applications: 1 });
	expect(await s.stored()).toBe(external);
});

test('a malformed row is a repair baseline: it can be renamed, replaced, and deleted under its hash', async () => {
	const s = await setup();
	await s.overwrite(MALFORMED);
	const broken = expectOk(await s.table.get('a'))!;
	expect(broken.parseError).toBeDefined();
	expectOk(
		await s.table.rename('a', 'moved', { expectedSha256: broken.sha256 }),
	);
	const moved = expectOk(await s.table.get('moved'))!;
	expect(moved).toEqual({ ...broken, path: 'todos/moved.md', stem: 'moved' });
	const repaired = expectOk(
		await s.table.replace('moved', VALID, { expectedSha256: moved.sha256 }),
	);
	expect(inspectRow(definition.tables.todos, repaired.text)).toMatchObject({
		parseError: undefined,
		issues: [],
	});
	// Arbitrary text, an empty file included, is saved exactly.
	const emptied = expectOk(
		await s.table.replace('moved', '', { expectedSha256: repaired.sha256 }),
	);
	expect(emptied.text).toBe('');
	expectOk(await s.table.delete('moved', { expectedSha256: emptied.sha256 }));
	expect(expectOk(await s.table.list())).toEqual([]);
});

test('a row that is not UTF-8 names the hash it read, so its repair can be guarded', async () => {
	const s = await setup();
	const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
	await s.put('todos/binary.md', bytes);
	const unreadable = expectErr(await s.table.get('binary'));
	expect(unreadable).toEqual(
		TableError.InvalidUtf8({
			path: 'todos/binary.md',
			sha256: await hashBytes(bytes),
		}).error,
	);
	if (unreadable.name !== 'InvalidUtf8') return;
	const [listed] = expectOk(await s.table.list()).filter(
		(item) => item.path === 'todos/binary.md',
	);
	expect(expectErr(listed!.result)).toEqual(unreadable);
	expect(expectErr(await s.table.update('binary', { body: 'x' }, {}))).toEqual(
		unreadable,
	);
	expectOk(
		await s.table.replace('binary', VALID, {
			expectedSha256: unreadable.sha256,
		}),
	);
	expect(await s.stored('todos/binary.md')).toBe(VALID);
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

test('a rename moves the row to a vacant stem, reads no row for its reply, and refuses a changed baseline', async () => {
	const s = await setup();
	const changed = expectOk(
		await s.table.update('a', { fields: { title: 'Outside' } }, {}),
	);
	const stale = expectErr(
		await s.table.rename('a', 'named', { expectedSha256: s.entry.sha256 }),
	);
	expect(stale).toMatchObject({
		name: 'Conflict',
		path: 'todos/a.md',
		expectedSha256: s.entry.sha256,
		actualSha256: changed.sha256,
	});
	expect(expectOk(await s.table.get('named'))).toBeUndefined();

	const counted = s.counts();
	expect(
		expectOk(
			await s.table.rename('a', 'named', { expectedSha256: changed.sha256 }),
		),
	).toBeUndefined();
	// Only the directory was listed for the destination; no row was read.
	expect(s.counts()).toEqual({
		reads: counted.reads,
		applications: counted.applications + 1,
	});
	expect(expectOk(await s.table.get('named'))).toEqual(
		interpreted(definition.tables.todos, {
			...changed,
			path: 'todos/named.md',
			stem: 'named',
		}),
	);
	expect(expectOk(await s.table.get('a'))).toBeUndefined();

	// Unguarded, it moves whatever bytes are there; a missing row is NotFound.
	expectOk(await s.table.rename('named', 'again', {}));
	expect(expectErr(await s.table.rename('named', 'other', {})).name).toBe(
		'NotFound',
	);
});

test('a rename to its own stem is InvalidPath before storage, never an unchecked success', async () => {
	const s = await setup();
	const stale = { expectedSha256: 'f'.repeat(64) };
	for (const refused of [
		expectErr(await s.table.rename('a', 'a', stale)),
		expectErr(
			await s.table.rename('a', 'a', { expectedSha256: s.entry.sha256 }),
		),
		expectErr(await s.table.rename('missing', 'missing', {})),
	])
		expect(refused).toMatchObject({
			name: 'InvalidPath',
			reason: 'A row cannot be renamed to the stem it already has',
		});
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });
	expect(expectOk(await s.table.get('missing'))).toBeUndefined();
	expect(await s.stored()).toBe(s.entry.text);
});

test('a move that landed but kept its source names a hash only when it was guarded', async () => {
	const s = await setup();
	const cause = FileError.Io({
		path: s.entry.path,
		operation: 'retire',
		cause: 'x',
	});
	s.storage.apply = async (changes) => {
		const [change] = changes;
		if (change?.kind !== 'move') throw new Error('expected a move');
		return ApplyError.Partial({
			applied: [{ kind: 'write', path: change.to }],
			failed: { kind: 'move', from: change.from, to: change.to },
			error: cause.error,
			notAttempted: [],
		});
	};
	expect(expectErr(await s.table.rename('a', 'b', {}))).toEqual(
		MoveError.SourceNotRemoved({
			from: 'todos/a.md',
			to: 'todos/b.md',
			moved: undefined,
			cause: cause.error,
		}).error,
	);
	expect(
		expectErr(
			await s.table.rename('a', 'b', { expectedSha256: s.entry.sha256 }),
		),
	).toEqual(
		MoveError.SourceNotRemoved({
			from: 'todos/a.md',
			to: 'todos/b.md',
			moved: { path: 'todos/b.md', sha256: s.entry.sha256 },
			cause: cause.error,
		}).error,
	);
});

test('a delete removes the row under an optional baseline, and an absent row is NotFound either way', async () => {
	const s = await setup();
	const stale = expectErr(
		await s.table.delete('a', { expectedSha256: 'f'.repeat(64) }),
	);
	expect(stale).toMatchObject({
		name: 'Conflict',
		actualSha256: s.entry.sha256,
	});
	expect(await s.stored()).toBe(s.entry.text);
	expect(
		expectOk(await s.table.delete('a', { expectedSha256: s.entry.sha256 })),
	).toBeUndefined();
	expect(expectErr(await s.table.delete('a', {})).name).toBe('NotFound');
	expect(
		expectErr(await s.table.delete('a', { expectedSha256: s.entry.sha256 }))
			.name,
	).toBe('NotFound');
	expect(expectOk(await s.table.list())).toEqual([]);
});

test('a missing row, per operation: what each reads first and what it answers, with and without a guard', async () => {
	const s = await setup();
	const guard = { expectedSha256: s.entry.sha256 };
	const outcomes = async (options: TableWriteOptions) => ({
		update: expectErr(await s.table.update('missing', { body: 'x' }, options))
			.name,
		replace: expectErr(await s.table.replace('missing', VALID, options)).name,
		rename: expectErr(await s.table.rename('missing', 'moved', options)).name,
		delete: expectErr(await s.table.delete('missing', options)).name,
	});
	expect(await outcomes({})).toEqual({
		update: 'NotFound',
		replace: 'NotFound',
		rename: 'NotFound',
		delete: 'NotFound',
	});
	// Only the operations whose guard is checked against bytes they hold
	// report absence as a failed condition.
	expect(await outcomes(guard)).toEqual({
		update: 'Conflict',
		replace: 'Conflict',
		rename: 'NotFound',
		delete: 'NotFound',
	});
	// Only `update` reads the row, and it stops there; the others read no row
	// and learn of the absence where their change is published.
	expect(s.counts()).toEqual({ reads: 2, applications: 6 });
	expect(expectOk(await s.table.get('moved'))).toBeUndefined();
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
		// A refinement that counts each value it is shown.
		counted: defineTable({
			fields: {
				word: refined({ type: 'string' }, () => {
					refinementCalls++;
					return true;
				}),
			},
		}),
	},
});
let refinementCalls = 0;

test('raw publication runs no refinement: only checking supplied values and inspecting text do', async () => {
	const s = await setup();
	const counted = tableOf<{ word: string }>(s.storage, refining, 'counted');
	refinementCalls = 0;
	const created = expectOk(
		await counted.create({ stem: 'c', fields: { word: 'apple' } }),
	);
	// `create` checks the value it was given, once.
	expect(refinementCalls).toBe(1);
	refinementCalls = 0;
	let sha256 = created.sha256;
	const receipts: TableWriteReceipt[] = [];
	for (let i = 0; i < 10; i++) {
		const receipt = expectOk(
			await counted.replace('c', `---\nword: pear\n---\n${i}\n`, {
				expectedSha256: sha256,
			}),
		);
		sha256 = receipt.sha256;
		receipts.push(receipt);
	}
	expectOk(await counted.rename('c', 'd', { expectedSha256: sha256 }));
	expectOk(await counted.delete('d', { expectedSha256: sha256 }));
	expect(refinementCalls).toBe(0);
	// Interpreting a receipt is the caller's choice, one refinement each.
	for (const receipt of receipts)
		inspectRow(refining.tables.counted, receipt.text);
	expect(refinementCalls).toBe(10);
});

test('a parent its refinement froze still has every child frozen, aliases included', () => {
	const reading = inspectRow(
		refining.tables.frozen,
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
	const updated = expectOk(await frozen.update('f', { fields: change }, {}));
	for (const node of [...nodesOf(supplied), ...nodesOf(change)])
		expect(Object.isFrozen(node)).toBe(false);
	supplied.data.list.push(2);
	change.data.list.push(4);
	expect(inspectRow(refining.tables.frozen, created.text).fields.data).toEqual({
		list: [1],
	});
	expect(inspectRow(refining.tables.frozen, updated.text).fields.data).toEqual({
		list: [3],
	});

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
		await mutating.update('m', { fields: { data: supplied.data } }, {}),
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
		text: source,
		fields: { title: 'A' },
		body: 'notes\n',
		parseError: undefined,
	});
	expect(Object.hasOwn(row.fields, 'data')).toBe(false);
	expect(row.issues.map((issue) => issue.field)).toEqual(['data']);
	expect(inspectRow(refining.tables.mutating, source).fields).toEqual({
		title: 'A',
	});

	// A complete replacement is published as written, with the same issue.
	const next = source.replace('answer: 1', 'answer: 2');
	const replaced = expectOk(
		await mutating.replace('m', next, { expectedSha256: row.sha256 }),
	);
	expect(await s.stored(row.path)).toBe(next);
	expect(replaced.text).toBe(next);
	expect(
		inspectRow(refining.tables.mutating, replaced.text).issues.map(
			(issue) => issue.field,
		),
	).toEqual(['data']);

	// Another field updates beside it and leaves its text alone.
	const updated = expectOk(
		await mutating.update('m', { fields: { title: 'B' } }, {}),
	);
	expect(updated.text).toBe(next.replace('title: A', 'title: B'));
	expect(inspectRow(refining.tables.mutating, updated.text).fields).toEqual({
		title: 'B',
	});
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
	const throwing = row.text.replace('guard: ok', 'guard: boom');
	const receipt = expectOk(
		await guarded.replace('g', throwing, { expectedSha256: row.sha256 }),
	);
	expect(await s.stored(row.path)).toBe(throwing);
	const replaced = interpreted(refining.tables.guarded, receipt);
	expect(replaced).toMatchObject({
		text: throwing,
		fields: { title: 'A' },
		body: 'notes\n',
		parseError: undefined,
	});
	expect(Object.hasOwn(replaced.fields, 'guard')).toBe(false);
	expect(replaced.issues.map((issue) => issue.field)).toEqual(['guard']);
	expect<unknown>(expectOk(await guarded.get('g'))).toEqual(replaced);

	// An update of another field goes through and leaves the stored text alone.
	const updated = expectOk(
		await guarded.update('g', { fields: { title: 'B' } }, {}),
	);
	expect(updated.text).toBe(throwing.replace('title: A', 'title: B'));
	expect(await s.stored(row.path)).toBe(updated.text);
	const reading = inspectRow(refining.tables.guarded, updated.text);
	expect(reading.fields).toEqual({ title: 'B' });
	expect(reading.issues.map((issue) => issue.field)).toEqual(['guard']);

	// The value itself is still refused as input.
	expect(
		expectErr(await guarded.update('g', { fields: { guard: 'boom' } }, {}))
			.name,
	).toBe('InvalidValues');
	expect(await s.stored(row.path)).toBe(updated.text);
});

test('a write receipt is not interpreted: create, replace, rename, and delete publish even when interpreting would fail', async () => {
	const s = await setup();
	// No declared field does this; it stands for a failure nobody planned for.
	// Interpreting source lists the table's fields, and that listing throws.
	let failing = false;
	const table = createTable<Todo>(
		{ storage: s.storage },
		'todos',
		new Proxy(definition.tables.todos.fields, {
			ownKeys(fields) {
				if (failing) throw new Error('the interpreter failed');
				return Reflect.ownKeys(fields);
			},
		}),
	);
	// A new row's values are checked before anything is read; the interpreter
	// starts failing at the directory read, after the values passed.
	const { children } = s.storage;
	s.storage.children = (...args) => {
		failing = true;
		return children(...args);
	};
	const fields = { title: 'New', done: false, tags: [] };
	expectOk(await table.create({ stem: 'b', fields }));
	s.storage.children = children;
	expect(failing).toBe(true);
	const replaced = expectOk(
		await table.replace('a', VALID, { expectedSha256: s.entry.sha256 }),
	);
	expect(replaced.text).toBe(VALID);
	expectOk(
		await table.rename('a', 'moved', { expectedSha256: replaced.sha256 }),
	);
	expectOk(await table.delete('b', {}));
	failing = false;
	expect(expectOk(await table.list()).map((item) => item.path)).toEqual([
		'todos/moved.md',
	]);
	expect(await s.stored('todos/moved.md')).toBe(VALID);
});

test('a receipt source is decoded from the submitted bytes: a byte-order mark, CRLF, and paired surrogates are kept', async () => {
	const s = await setup();
	const exact =
		'﻿---\r\ntitle: "\u{1F600} café"\r\ndone: false\r\ntags: []\r\n---\r\nbody\r\n';
	const saved = expectOk(await s.table.replace('a', exact, {}));
	expect(saved.text).toBe(exact);
	expect(saved.sha256).toBe(await hashBytes(encoder.encode(exact)));
	expect(await s.stored()).toBe(exact);
	expect(expectOk(await s.table.get('a'))).toEqual(
		interpreted(definition.tables.todos, saved),
	);
	// The receipt's hash guards a rename of the same bytes.
	expectOk(
		await s.table.rename('a', 'named', { expectedSha256: saved.sha256 }),
	);
	expect(await s.stored('todos/named.md')).toBe(exact);
});
