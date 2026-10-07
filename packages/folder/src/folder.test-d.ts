/**
 * A folder reads its tables and KV through the declaration's own lenses, and
 * every acquisition entry exports one opener signature and one contract.
 */
import { expectTypeOf } from 'bun:test';
import { jsonValue } from '@epicenter/definition';
import type { InstantString } from '@epicenter/definition/field';
import type { Result } from 'wellcrafted/result';
import * as browser from './browser.js';
import * as bun from './bun.js';
import type * as contract from './contract.js';
import * as root from './index.js';
import {
	type CapturedFile,
	type CapturedMoveError,
	type CreateRowOf,
	type DeepReadonly,
	defineFolder,
	defineTable,
	type FieldIssue,
	type FileCapture,
	type FileError,
	type FileKv,
	type FileTable,
	type Folder,
	type FolderLocation,
	type FolderTerminal,
	field,
	inspectRow,
	type KvOf,
	type KvReadError,
	type KvReading,
	type KvSnapshot,
	type KvWriteError,
	type MoveError,
	type OpenFolder,
	type OpenFolderError,
	type OpenFolderOptions,
	type ParseError,
	type PreparedFolderTable,
	serializeRow,
	type TableCreateError,
	type TableDeleteError,
	type TableEnumerationError,
	type TableGetError,
	type TableListing,
	type TableReadError,
	type TableReading,
	type TableRenameError,
	type TableReplaceError,
	type TableSnapshot,
	type TableUpdateError,
	type TableWriteOptions,
	type TableWriteReceipt,
	type TextCapture,
} from './index.js';
import * as tauri from './tauri.js';

const definition = defineFolder({
	kv: { theme: field.string() },
	tables: {
		todos: defineTable({
			fields: {
				title: field.string(),
				due: field.nullable(field.instant()),
			},
		}),
	},
});
type Opened = Folder<typeof definition>;

// Nested values: a list, a branded instant, a tuple, and free-form JSON.
const nested = defineFolder({
	kv: {
		recent: field.tags(),
		since: field.instant(),
		layout: field.json(jsonValue),
	},
	tables: {
		notes: defineTable({
			fields: {
				tags: field.tags(),
				at: field.instant(),
				meta: field.json(jsonValue),
			},
		}),
	},
});
type Note = CreateRowOf<typeof nested.tables.notes>;

// Only a table `defineFolder` prepared is read or previewed without a folder.
const rawTodos = defineTable({
	fields: {
		title: field.string(),
		due: field.nullable(field.instant()),
	},
});
// @ts-expect-error A raw declaration was never prepared.
inspectRow(rawTodos, '---\ntitle: Milk\n---\n');
// @ts-expect-error Nor is it previewed.
serializeRow(rawTodos, { fields: { title: 'Milk' } });
// An opener still takes a raw declaration and prepares it itself.
void root.openFolder({
	id: 'test.folder',
	definition: { kv: {}, tables: { todos: rawTodos } },
});
// Preparing changes no key or field type.
expectTypeOf(definition.tables.todos).toExtend<PreparedFolderTable>();
expectTypeOf<keyof typeof definition.tables.todos.fields>().toEqualTypeOf<
	'title' | 'due'
>();
expectTypeOf<CreateRowOf<typeof definition.tables.todos>>().toEqualTypeOf<
	CreateRowOf<typeof rawTodos>
>();
// A generic helper constrained to prepared tables keeps the exact table.
function readDraft<const TTable extends PreparedFolderTable>(
	table: TTable,
	text: string,
) {
	return inspectRow(table, text);
}
expectTypeOf(readDraft(definition.tables.todos, '')).toEqualTypeOf<
	TableReading<CreateRowOf<typeof definition.tables.todos>>
>();
// @ts-expect-error It refuses a raw declaration as well.
readDraft(rawTodos, '');
// A spread that keeps the prepared field objects keeps the mark, and reads.
expectTypeOf(
	inspectRow({ ...definition.tables.todos }, '').fields,
).toEqualTypeOf<
	DeepReadonly<Partial<CreateRowOf<typeof definition.tables.todos>>>
>();
// The mark is a type, not a proof: a spread with replaced fields still
// compiles, and reading a value through them throws (`definition.test.ts`).
inspectRow({ ...definition.tables.todos, fields: rawTodos.fields }, '');

// Readonly reaches every depth and stops at primitives, so a brand survives.
expectTypeOf<DeepReadonly<InstantString>>().toEqualTypeOf<InstantString>();
expectTypeOf<
	DeepReadonly<InstantString | null>
>().toEqualTypeOf<InstantString | null>();
expectTypeOf<DeepReadonly<unknown>>().toEqualTypeOf<unknown>();
expectTypeOf<
	DeepReadonly<{ a: { b: string[] }[]; pair: [InstantString, number] }>
>().toEqualTypeOf<{
	readonly a: readonly { readonly b: readonly string[] }[];
	readonly pair: readonly [InstantString, number];
}>();
expectTypeOf<DeepReadonly<Partial<Note>>['at']>().toEqualTypeOf<
	InstantString | undefined
>();
expectTypeOf<DeepReadonly<Partial<Note>>['tags']>().toEqualTypeOf<
	readonly string[] | undefined
>();

async function nestedValues(
	folder: Folder<typeof nested>,
	instant: InstantString,
) {
	const { notes } = folder.tables;
	const { data: snapshot, error: readError } = await notes.get('a');
	if (readError !== null || snapshot === undefined) return;
	const { tags, at, meta } = snapshot.fields;
	// @ts-expect-error A snapshot's list cannot be changed in place.
	snapshot.fields.tags?.push('later');
	// @ts-expect-error Nor can its field map.
	snapshot.fields.at = instant;
	// Free-form JSON contains itself, and is readonly at every depth too.
	type ReadonlyJson =
		| string
		| number
		| boolean
		| null
		| readonly ReadonlyJson[]
		| { readonly [key: string]: ReadonlyJson };
	expectTypeOf(meta).toEqualTypeOf<ReadonlyJson | undefined>();

	// Fields are partial whatever the diagnostics say, so each is checked.
	// @ts-expect-error A reading is never a complete row.
	notes.create({ fields: snapshot.fields });
	if (tags !== undefined && at !== undefined && meta !== undefined)
		// Snapshot values go back in with no cast, and so do plain mutable ones.
		notes.create({ fields: { tags, at, meta } });
	notes.create({ fields: { tags: ['a'], at: instant, meta: { a: [1] } } });
	notes.update('a', { fields: snapshot.fields }, {});
	notes.update('a', { fields: { tags: ['a'] as const } }, {});
	// @ts-expect-error An unvalidated string still does not carry the brand.
	notes.update('a', { fields: { at: '2026-10-01T00:00:00.000Z' } }, {});
	// A draft's values are the same readonly types, read from the definition.
	expectTypeOf(inspectRow(nested.tables.notes, '').fields).toEqualTypeOf(
		snapshot.fields,
	);

	const { data: kv, error: kvError } = await folder.kv.get();
	if (kvError !== null || kv === undefined) return;
	expectTypeOf(kv.values.since).toEqualTypeOf<InstantString | undefined>();
	expectTypeOf(kv.values.recent).toEqualTypeOf<readonly string[] | undefined>();
	// @ts-expect-error Stored values cannot be changed in place.
	kv.values.recent?.push('later');
	folder.kv.update(kv.values);
	folder.kv.create(kv.values);
	folder.kv.update({ recent: ['a'], since: instant, layout: { panes: [1] } });
	// @ts-expect-error An unvalidated string still does not carry the brand.
	folder.kv.update({ since: '2026-10-01T00:00:00.000Z' });
}
void nestedValues;

// A tuple that ends in a rest keeps its positions: a required head, then any
// number of the rest. Written as a native schema, which is a field like any.
const headed = {
	type: 'array',
	items: [{ type: 'string' }],
	additionalItems: { type: 'number' },
	minItems: 1,
} as const;
const tuples = defineFolder({
	kv: { span: headed },
	tables: { rows: defineTable({ fields: { span: headed } }) },
});
type Span = CreateRowOf<typeof tuples.tables.rows>['span'];
expectTypeOf<Span>().toEqualTypeOf<[string, ...number[]]>();
expectTypeOf<DeepReadonly<Span>>().toEqualTypeOf<
	readonly [string, ...number[]]
>();
expectTypeOf<DeepReadonly<[string?, ...number[]]>>().toEqualTypeOf<
	readonly [string?, ...number[]]
>();
expectTypeOf<
	DeepReadonly<[{ a: string[] }, ...{ b: number }[]]>
>().toEqualTypeOf<
	readonly [{ readonly a: readonly string[] }, ...{ readonly b: number }[]]
>();

async function tupleValues(folder: Folder<typeof tuples>) {
	const { rows } = folder.tables;
	const { data: snapshot, error: readError } = await rows.get('a');
	if (readError !== null || snapshot === undefined) return;
	const { span } = snapshot.fields;
	expectTypeOf(span).toEqualTypeOf<
		readonly [string, ...number[]] | undefined
	>();
	if (span === undefined) return;
	expectTypeOf(span[0]).toEqualTypeOf<string>();
	expectTypeOf(span[1]).toEqualTypeOf<number | undefined>();
	// @ts-expect-error A snapshot's tuple cannot be changed in place.
	span.push(1);
	// @ts-expect-error Nor can one of its positions.
	span[0] = 'b';

	// What was read goes back in, and input keeps the head it requires.
	rows.update('a', { fields: { span } }, {});
	rows.update('a', { fields: { span: ['a', 1, 2] } }, {});
	rows.create({ fields: { span: ['a'] } });
	// @ts-expect-error The head is a string.
	rows.update('a', { fields: { span: [1, 'a'] } });
	// @ts-expect-error The head is required.
	rows.update('a', { fields: { span: [] } });
	// @ts-expect-error The rest are numbers.
	rows.create({ fields: { span: ['a', 'b'] } });

	const { data: kv, error: kvError } = await folder.kv.get();
	if (kvError !== null || kv === undefined) return;
	expectTypeOf(kv.values.span).toEqualTypeOf<
		readonly [string, ...number[]] | undefined
	>();
	// @ts-expect-error Stored values cannot be changed in place.
	kv.values.span?.push(1);
	folder.kv.update(kv.values);
	folder.kv.update({ span: ['a', 1] });
	// @ts-expect-error The head is a string.
	folder.kv.update({ span: [1, 'a'] });
	// @ts-expect-error The head is required.
	folder.kv.create({ span: [] });
}
void tupleValues;

expectTypeOf<Opened['tables']['todos']>().toEqualTypeOf<
	FileTable<CreateRowOf<typeof definition.tables.todos>>
>();
expectTypeOf<Opened['kv']>().toEqualTypeOf<FileKv<KvOf<typeof definition>>>();
expectTypeOf<
	CreateRowOf<typeof definition.tables.todos>['due']
>().toEqualTypeOf<InstantString | null>();

// One opener signature at the automatic entry and at both explicit entries.
expectTypeOf(root.openFolder).toEqualTypeOf<OpenFolder>();
expectTypeOf(browser.openFolder).toEqualTypeOf<OpenFolder>();
expectTypeOf(tauri.openFolder).toEqualTypeOf<OpenFolder>();
expectTypeOf(browser.openFolder).toEqualTypeOf(root.openFolder);
expectTypeOf(tauri.openFolder).toEqualTypeOf(root.openFolder);
expectTypeOf(root.openFolder<typeof definition>).returns.toEqualTypeOf<
	Promise<Result<Opened, OpenFolderError>>
>();
expectTypeOf(root.openFolder<typeof definition>)
	.parameter(0)
	.toEqualTypeOf<OpenFolderOptions<typeof definition>>();
// The opener names the folder; the definition does not.
expectTypeOf<
	OpenFolderOptions<typeof definition>['id']
>().toEqualTypeOf<string>();
// @ts-expect-error A folder is opened by its ID.
void root.openFolder({ definition });
void root.openFolder({
	id: 'test.folder',
	// @ts-expect-error A definition that names its data is not a folder definition.
	definition: { id: 'test.folder', kv: {}, tables: {} },
});

// Every entry exports the same contract, so a build may resolve one for another.
type Contract = typeof contract;
type EntryPoint<T> = Omit<T, 'openFolder'>;
expectTypeOf<EntryPoint<typeof root>>().toEqualTypeOf<Contract>();
// Creating is the default; an opener can be told not to create.
expectTypeOf<contract.BrowserFolderOptions['createIfMissing']>().toEqualTypeOf<
	boolean | undefined
>();
expectTypeOf<Extract<contract.OpenFolderError, { name: 'Absent' }>>()
	.toHaveProperty('directory')
	.toEqualTypeOf<string>();

// The browser entry adds only its download, which no other entry has.
expectTypeOf<Pick<typeof browser, keyof Contract>>().toEqualTypeOf<Contract>();
expectTypeOf<
	Exclude<keyof typeof browser, keyof Contract | 'openFolder'>
>().toEqualTypeOf<'downloadFolder' | 'DownloadFolderError'>();
expectTypeOf<EntryPoint<typeof tauri>>().toEqualTypeOf<Contract>();
expectTypeOf<Pick<typeof bun, keyof Contract>>().toEqualTypeOf<Contract>();

// The directory opener is its own contract: an explicit root and history.
expectTypeOf(bun.openFolder<typeof definition>)
	.parameter(0)
	.toEqualTypeOf<bun.DirectoryFolderOptions<typeof definition>>();
expectTypeOf(bun.openFolder<typeof definition>).returns.toEqualTypeOf<
	Promise<Result<Opened, OpenFolderError>>
>();

async function typedValues(
	folder: Opened,
	snapshot: KvSnapshot<KvOf<typeof definition>>,
	instant: InstantString,
) {
	folder.tables.todos.create({ fields: { title: 'Milk', due: null } });
	folder.tables.todos.create({ fields: { title: 'Milk', due: instant } });
	folder.tables.todos.create({
		// @ts-expect-error An unvalidated string does not carry the instant brand.
		fields: { title: 'Milk', due: '2026-10-01T00:00:00.000Z' },
	});
	// @ts-expect-error Typed fields retain validation.
	folder.tables.todos.create({ fields: { title: 12, due: null } });
	// @ts-expect-error Creating a row supplies every declared field.
	folder.tables.todos.create({ fields: { title: 'Milk' } });
	folder.tables.todos.create({
		fields: { title: 'Milk', due: null },
		// @ts-expect-error A row carries no attachment.
		attachment: {},
	});
	// @ts-expect-error Only declared tables exist.
	folder.tables.lists;
	folder.kv.create({});
	folder.kv.create({ theme: 'dark' });
	// @ts-expect-error Only declared settings exist.
	folder.kv.create({ language: 'en' });
	folder.kv.update({ theme: 'dark' });
	// @ts-expect-error Typed settings retain validation.
	folder.kv.update({ theme: 12 });
	// @ts-expect-error Only declared settings exist.
	folder.kv.update({ language: 'en' });
	// @ts-expect-error An update names values, not a captured baseline.
	folder.kv.update(snapshot, { theme: 'dark' });
	// @ts-expect-error Complete source is saved as an ordinary file.
	folder.kv.replace(snapshot, '{}');
	// A snapshot is a text capture of `kv.json`; absence is `undefined`.
	expectTypeOf(snapshot).toExtend<TextCapture>();
	// @ts-expect-error A captured observation keeps its version.
	snapshot.sha256 = 'changed';
	// @ts-expect-error A captured observation keeps its source.
	snapshot.source = '{}';
	expectTypeOf(snapshot.path).toEqualTypeOf<'kv.json'>();
	// Stored values are sparse and sit apart from the capture's own keys.
	expectTypeOf(snapshot.values).toEqualTypeOf<{ readonly theme?: string }>();
	expectTypeOf(snapshot.parseError).toEqualTypeOf<ParseError | undefined>();
	expectTypeOf(snapshot.issues).toEqualTypeOf<readonly FieldIssue[]>();
	// @ts-expect-error A snapshot carries no defaults.
	snapshot.defaults;
	// @ts-expect-error Values are not flattened beside the capture.
	snapshot.theme;
	const observed = await folder.kv.get();
	if (observed.error === null)
		expectTypeOf(observed.data).toEqualTypeOf<
			KvSnapshot<KvOf<typeof definition>> | undefined
		>();
	else expectTypeOf(observed.error).toEqualTypeOf<KvReadError>();
	// The same interpretation of unsaved text is a plain reading, not a Result.
	expectTypeOf(folder.kv.inspect('{}')).toEqualTypeOf<
		KvReading<KvOf<typeof definition>>
	>();
	expectTypeOf(snapshot).toExtend<KvReading<KvOf<typeof definition>>>();
	const { error: assignError } = await folder.kv.update({ theme: 'dark' });
	if (assignError !== null) {
		expectTypeOf(assignError).toEqualTypeOf<KvWriteError>();
		// Unparsed current source and an unsafe patch are distinct names.
		if (assignError.name === 'Unparsed')
			expectTypeOf(assignError.error).toEqualTypeOf<ParseError>();
		if (assignError.name === 'UnsupportedSource')
			expectTypeOf(assignError.reason).toEqualTypeOf<string>();
	}
	folder.files.replace(snapshot, '{}');

	// Captures are plain values; a read also carries detached bytes.
	const { data: file, error: readError } = await folder.files.read('a.md');
	if (readError !== null) return;
	expectTypeOf(file).toEqualTypeOf<CapturedFile>();
	const { data: replaced, error: replaceError } = await folder.files.replace(
		file,
		'next',
	);
	if (replaceError !== null) return;
	expectTypeOf(replaced).toEqualTypeOf<FileCapture>();
	expectTypeOf(await folder.files.remove(replaced)).toEqualTypeOf<
		Awaited<ReturnType<Opened['files']['remove']>>
	>();
	// A table snapshot is a capture of its row file with its reading beside it.
	const entry = await folder.tables.todos.get('milk');
	type Fields = CreateRowOf<typeof definition.tables.todos>;
	if (entry.error === null) {
		expectTypeOf(entry.data).toEqualTypeOf<TableSnapshot<Fields> | undefined>();
	} else expectTypeOf(entry.error).toEqualTypeOf<TableGetError>();
	if (entry.data) {
		expectTypeOf(entry.data).toExtend<TextCapture>();
		expectTypeOf(entry.data).toExtend<TableReading<Fields>>();
		// @ts-expect-error There is no parse Result to go through.
		entry.data.content;
		// @ts-expect-error A capture keeps its source.
		entry.data.source = '';
		// @ts-expect-error And its reading.
		entry.data.fields = {};
		// Fields are partial whether or not there are issues.
		expectTypeOf(entry.data.fields).toEqualTypeOf<{
			readonly title?: string;
			readonly due?: InstantString | null;
		}>();
		// The body is absent exactly when the source does not parse.
		expectTypeOf(entry.data.body).toEqualTypeOf<string | undefined>();
		expectTypeOf(entry.data.parseError).toEqualTypeOf<ParseError | undefined>();
		if (entry.data.parseError)
			expectTypeOf(
				entry.data.parseError.diagnostics[0].message,
			).toEqualTypeOf<string>();
		// Issues are always an array, so there is no presence check to make.
		expectTypeOf(entry.data.issues).toEqualTypeOf<readonly FieldIssue[]>();
		expectTypeOf<keyof FieldIssue>().toEqualTypeOf<
			'field' | 'path' | 'message'
		>();
		// @ts-expect-error Diagnostics cannot be changed in place.
		entry.data.issues.push({ field: 'title', message: '' });
	}
	// One synchronous interpreter for saved text and for drafts, on the
	// definition rather than an open table: a plain reading.
	expectTypeOf(inspectRow(definition.tables.todos, '---\n---\n')).toEqualTypeOf<
		TableReading<Fields>
	>();
	// @ts-expect-error A draft has no capture.
	inspectRow(definition.tables.todos, '---\n---\n').sha256;
	// @ts-expect-error Interpretation is not a method of an open table.
	folder.tables.todos.inspect;
	// A preview names declared keys and holds any value, conforming or not.
	expectTypeOf(
		serializeRow(definition.tables.todos, {
			fields: { title: 12, due: 'not yet an instant' },
			body: 'b',
		}),
	).toEqualTypeOf<
		Result<string, Extract<TableCreateError, { name: 'InvalidValues' }>>
	>();
	serializeRow(definition.tables.todos, { fields: {} });
	// @ts-expect-error A preview names only declared fields.
	serializeRow(definition.tables.todos, { fields: { titel: 'Milk' } });
	// @ts-expect-error A preview takes a definition's table, not an open one.
	serializeRow(folder.tables.todos, { fields: {} });
	// A listing is one array of per-file Results under one enumeration Result.
	const listing = await folder.tables.todos.list();
	expectTypeOf(listing).toEqualTypeOf<
		Result<TableListing<Fields>, TableEnumerationError>
	>();
	if (listing.error === null) {
		expectTypeOf(listing.data[0]!.result).toEqualTypeOf<
			Result<TableSnapshot<Fields>, TableReadError>
		>();
		// @ts-expect-error There is no separate list of unreadable files.
		listing.data.unreadable;
	}
	// Each save adds its preparation errors to the shared storage error family.
	const { data: receipt, error: saveError } = await folder.tables.todos.replace(
		'milk',
		'',
		{},
	);
	if (saveError === null) {
		// A write receipt names the submitted bytes; it carries no reading.
		expectTypeOf(receipt).toEqualTypeOf<TableWriteReceipt>();
		expectTypeOf<keyof TableWriteReceipt>().toEqualTypeOf<
			'stem' | 'path' | 'text' | 'sha256'
		>();
		// @ts-expect-error Interpreting a receipt is `inspectRow(table, receipt.text)`.
		receipt.fields;
		// @ts-expect-error Whole-file content is `text`; `source` is gone.
		receipt.source;
	}
	if (saveError !== null) {
		expectTypeOf(saveError).toEqualTypeOf<TableReplaceError>();
		// @ts-expect-error Saving text that does not parse is not a failure.
		saveError.name === 'Unparsed';
		// @ts-expect-error A replacement supplies no field values.
		saveError.name === 'InvalidValues';
	}
	const { error: updateError } = await folder.tables.todos.update(
		'milk',
		{
			body: '',
		},
		{},
	);
	if (updateError !== null) {
		expectTypeOf(updateError).toEqualTypeOf<TableUpdateError>();
		// The two preparation refusals are distinct names.
		if (updateError.name === 'Unparsed')
			expectTypeOf(updateError.error).toEqualTypeOf<ParseError>();
		if (updateError.name === 'UnsupportedSource')
			expectTypeOf(updateError.reason).toEqualTypeOf<string>();
	}
	const { error: createError } = await folder.tables.todos.create({
		fields: { title: 'Milk', due: null },
	});
	if (createError !== null) {
		expectTypeOf(createError).toEqualTypeOf<TableCreateError>();
		// An occupied destination is the files' error, with the files' shape.
		if (createError.name === 'Exists')
			expectTypeOf(createError).toEqualTypeOf<
				Extract<FileError, { name: 'Exists' }>
			>();
		// @ts-expect-error A table has no naming rule of its own.
		createError.name === 'InvalidStem';
		// @ts-expect-error Nor a collision rule.
		createError.name === 'Collision';
		// @ts-expect-error Text is decoded only by reads.
		createError.name === 'InvalidUtf8';
	}
	folder.tables.todos.update(
		'milk',
		{
			fields: { title: 'Next' },
			body: 'body',
		},
		{},
	);
	// @ts-expect-error Updates name a stem, not a captured baseline.
	folder.tables.todos.update(entry.data, { fields: { title: 'Next' } }, {});
	// @ts-expect-error Structured commands still validate the supplied field types.
	folder.tables.todos.update('milk', { fields: { title: 12 } }, {});
	// Options are required on every mutation: `{}` is the current row.
	// @ts-expect-error update without options
	folder.tables.todos.update('milk', { body: '' });
	// @ts-expect-error replace without options
	folder.tables.todos.replace('milk', 'next');
	// @ts-expect-error rename without options
	folder.tables.todos.rename('milk', 'next');
	// @ts-expect-error delete without options
	folder.tables.todos.delete('milk');
	// @ts-expect-error An explicit undefined is not options either.
	folder.tables.todos.delete('milk', undefined);
	// @ts-expect-error A misspelled guard is not an option.
	folder.tables.todos.delete('milk', { expectedSHA256: 'a'.repeat(64) });
	// A wrapper must pass options to its inner call, so a stem-only forwarder
	// does not compile where it calls the table.
	const forwarding: Pick<FileTable<Fields>, 'delete' | 'replace'> = {
		delete: (stem, options) => folder.tables.todos.delete(stem, options),
		replace: (stem, text, options) =>
			folder.tables.todos.replace(stem, text, options),
	};
	void forwarding;
	const dropping: Pick<FileTable<Fields>, 'delete'> = {
		// @ts-expect-error The inner call drops the options it was given.
		delete: (stem) => folder.tables.todos.delete(stem),
	};
	void dropping;
	// The requirement stops at the call site: a wrapper that hands the table
	// `{}` of its own compiles and drops its caller's guard. That is a choice
	// the code states, not one the type can refuse.
	const replacing: Pick<FileTable<Fields>, 'delete'> = {
		delete: (stem, _options: TableWriteOptions) =>
			folder.tables.todos.delete(stem, {}),
	};
	void replacing;
	if (entry.data) {
		// Every table mutation names a stem; a baseline is an option of bytes.
		const guard = { expectedSha256: entry.data.sha256 };
		folder.files.replace(entry.data, entry.data.text);
		folder.tables.todos.update('milk', { body: '' }, guard);
		folder.tables.todos.replace('milk', entry.data.text, guard);
		folder.tables.todos.replace('milk', entry.data.text, {});
		// @ts-expect-error A capture is not an address.
		folder.tables.todos.replace(entry.data, entry.data.text, {});
		// @ts-expect-error The old source-write spelling is removed.
		folder.tables.todos.writeSource(entry.data, entry.data.text);
		// @ts-expect-error A snapshot is not options: it has no `expectedSha256`.
		folder.tables.todos.delete('milk', entry.data);
		expectTypeOf(
			await folder.tables.todos.rename('milk', 'next', guard),
		).toEqualTypeOf<Result<undefined, TableRenameError>>();
		expectTypeOf(await folder.tables.todos.delete('milk', guard)).toEqualTypeOf<
			Result<undefined, TableDeleteError>
		>();
		// @ts-expect-error A baseline is a hash, not a capture.
		folder.tables.todos.delete('milk', { expectedSha256: entry.data });
	}
	folder.tables.todos.replace('milk', 'next', {});
	folder.tables.todos.delete('milk', {});
	// @ts-expect-error A captured hash is required for removal.
	folder.files.remove({ path: 'a.md' });
	folder.files.replace(
		// @ts-expect-error Captures carry a flat hash, not a version wrapper.
		{ path: 'a.md', version: { sha256: 'a'.repeat(64) } },
		'next',
	);
	// @ts-expect-error A path alone is not a capture: `overwrite` says that.
	folder.files.replace('a.md', 'next');
	// @ts-expect-error The old single write verb is gone.
	folder.files.write('a.md', 'next', { expected: 'any' });

	// Each write is one file change: a failure is that file's, and only a
	// move names the two paths it touched.
	const { error: fileCreateError } = await folder.files.create('a.md', 'a');
	if (fileCreateError !== null)
		expectTypeOf(fileCreateError).toEqualTypeOf<FileError>();
	const { error: moveError } = await folder.files.move(replaced, 'b.md');
	// A file move is always guarded, so a kept source names the moved capture.
	if (moveError !== null) {
		expectTypeOf(moveError).toEqualTypeOf<FileError | CapturedMoveError>();
		if (moveError.name === 'SourceNotRemoved')
			expectTypeOf(moveError.moved).toEqualTypeOf<FileCapture>();
	}
	// A table rename may be unguarded, so its kept source may name no hash.
	expectTypeOf<TableRenameError>().toEqualTypeOf<FileError | MoveError>();
	expectTypeOf<
		Extract<MoveError, { name: 'SourceNotRemoved' }>['moved']
	>().toEqualTypeOf<FileCapture | undefined>();
	// @ts-expect-error Several changes are several calls; there is no batch.
	folder.batch;

	expectTypeOf(folder.location).toEqualTypeOf<FolderLocation>();
	expectTypeOf(folder.terminal()).toEqualTypeOf<FolderTerminal>();
	expectTypeOf(folder.onFilesChanged(() => {})).toEqualTypeOf<() => void>();
}
void typedValues;

// A table with a body conversion is not a folder table.
defineFolder({
	kv: {},
	tables: {
		// @ts-expect-error A folder stores the body as the file's Markdown text.
		notes: defineTable({
			fields: { title: field.string() },
			body: { encode: () => '', decode: () => undefined },
		}),
	},
});
defineFolder({
	// @ts-expect-error A folder definition names no folder; the opener does.
	id: 'test.named',
	kv: {},
	tables: {},
});
defineFolder({
	kv: {},
	tables: {
		// @ts-expect-error A table is authored with `defineTable`.
		notes: { fields: { title: field.string() } },
	},
});
