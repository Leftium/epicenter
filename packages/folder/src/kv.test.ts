/**
 * KV Tests
 *
 * `folder.kv` reads, creates, and updates the root `kv.json`. These drive the
 * KV methods and the ordinary file methods over one browser storage, so what
 * a method reads and publishes can be counted and held.
 *
 * Key behaviors:
 * - `get` returns `undefined` only for a missing file; unreadable bytes are an
 *   error, and readable text that is not a JSON object is a snapshot with a
 *   parse error, no values, and no issues
 * - A stored value that does not conform is an issue; a key the file lacks is
 *   not, and no default stands in for it
 * - `inspect` is the one interpreter: reads, receipts, and drafts agree
 * - Values and diagnostics are frozen at every depth; supplied values are
 *   copied and the caller's objects are left as they were
 * - A key's refinement is shown only a frozen value this module owns: one
 *   that changes it is an issue and changes nothing
 * - `create` validates the supplied keys, reads nothing, and never replaces
 * - `update` reads once, refuses a missing or unpatchable file, and publishes
 *   once against what it read
 * - Supplied values are owned when the method is called
 * - Everything outside an assigned value stays byte for byte
 * - Current source that does not parse is `Unparsed`; an object the keys
 *   cannot be assigned in safely is `UnsupportedSource`; both are repaired
 *   through `files.replace`
 *
 * See also:
 * - `browser.test.ts` and `close.test.ts` for history and close around a KV save
 */
import { expect, test } from 'bun:test';
import { accepts, jsonValue } from '@epicenter/definition';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { FolderStorage } from './boundary.js';
import {
	createBrowserFileBoundary,
	openFolderDatabase,
} from './browser-store.js';
import { hashBytes } from './capture.js';
import { defineFolder, field, type KvOf } from './contract.js';
import { createFiles } from './files.js';
import { createKv, type KvSnapshot } from './kv.js';

const definition = defineFolder({
	kv: {
		theme: field.string(),
		size: field.number(),
		layout: field.json(jsonValue),
	},
	tables: {},
});
type Values = KvOf<typeof definition>;

const encoder = new TextEncoder();
// Keep a byte order mark in what a test reads back.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const BOM = '\uFEFF';

/** The interpretation a snapshot carries, without its capture. */
const readingOf = ({ values, parseError, issues }: KvSnapshot<Values>) => ({
	values,
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

/** KV and file methods over one storage whose reads and publications are counted. */
async function setup(initial?: string | Uint8Array) {
	const environment = { indexedDB: new IDBFactory(), IDBKeyRange };
	const db = await openFolderDatabase('epicenter-folder:kv', environment);
	const base = createBrowserFileBoundary(db, environment);
	const calls = { reads: 0, applies: 0 };
	/** Set to run once after the next read has its bytes, before the caller sees them. */
	let afterRead: (() => Promise<void>) | undefined;
	const storage: FolderStorage = {
		...base,
		async read(path) {
			calls.reads += 1;
			const read = await base.read(path);
			const after = afterRead;
			afterRead = undefined;
			await after?.();
			return read;
		},
		apply(changes) {
			calls.applies += 1;
			return base.apply(changes);
		},
	};
	const files = createFiles({ storage: base });
	if (initial !== undefined) expectOk(await files.create('kv.json', initial));
	return {
		storage,
		kv: createKv<Values>({ storage }, definition.kv),
		files,
		calls,
		source: async () =>
			decoder.decode(expectOk(await files.read('kv.json')).bytes),
		afterNextRead(work: () => Promise<void>) {
			afterRead = work;
		},
	};
}

// ============================================================================
// get
// ============================================================================

test('get returns undefined for a missing file and a failed read as its error', async () => {
	const { kv } = await setup();
	expect(expectOk(await kv.get())).toBeUndefined();

	const unreadable = createKv<Values>(
		{
			storage: {
				read: async (path: string) => ({
					data: null,
					error: {
						name: 'Io' as const,
						message: 'disk refused',
						path,
						operation: 'read',
						cause: undefined,
					},
				}),
			} as unknown as FolderStorage,
		},
		definition.kv,
	);
	expect(expectErr(await unreadable.get()).name).toBe('Io');
});

test('get returns invalid UTF-8 as an error, not as a missing file', async () => {
	const { kv } = await setup(new Uint8Array([0x7b, 0xff, 0x7d]));
	expect(expectErr(await kv.get()).name).toBe('InvalidUtf8');
	expect(expectErr(await kv.update({ theme: 'dark' })).name).toBe(
		'InvalidUtf8',
	);
});

test('get returns a text capture with the stored values that validated, and a missing key is not an issue', async () => {
	// `layout` is declared and absent: it is left out, not reported or defaulted.
	const source = '{"theme": "dark", "size": "large", "other": [1]}';
	const { kv } = await setup(source);
	const snapshot = expectOk(await kv.get());
	expect(snapshot).toEqual({
		path: 'kv.json',
		sha256: await hashBytes(encoder.encode(source)),
		source,
		values: { theme: 'dark' },
		parseError: undefined,
		issues: [{ field: 'size', message: expect.stringContaining('size') }],
	});
	// A read and a draft are interpreted by the same function.
	expect(kv.inspect(source)).toEqual(readingOf(snapshot!));
	expect(Object.keys(kv.inspect(source)).sort()).toEqual([
		'issues',
		'parseError',
		'values',
	]);
});

test.each([
	['malformed JSON', '{"theme": '],
	['a comment', '{/* note */ "theme": "light"}'],
	['a trailing comma', '{"theme": "light",}'],
	['a JSON array', '["dark"]'],
	['a JSON string', '"dark"'],
	['null', 'null'],
	['an empty file', ''],
])('get returns %s as a snapshot with a parse error, no values, and no issues', async (_name, source) => {
	const { kv } = await setup(source);
	const snapshot = expectOk(await kv.get());
	expect(snapshot).toEqual({
		path: 'kv.json',
		sha256: await hashBytes(encoder.encode(source)),
		source,
		values: {},
		parseError: expect.anything(),
		issues: [],
	});
	const [first] = snapshot?.parseError?.diagnostics ?? [];
	expect(typeof first?.message).toBe('string');
	expect(kv.inspect(source)).toEqual(readingOf(snapshot!));
});

test('a stored value is reported where it fails, and a repeated root key reads as its last value', async () => {
	const { kv } = await setup();
	const nested = defineFolder({
		kv: {
			window: {
				type: 'object',
				properties: { width: { type: 'integer' } },
				required: ['width'],
			},
			theme: field.nullable(field.string()),
		},
		tables: {},
	});
	const typed = createKv<KvOf<typeof nested>>(
		{ storage: undefined as never },
		nested.kv,
	);
	const reading = typed.inspect('{"window": {"width": 1.5}, "theme": null}');
	// A stored null is a value; the pointer names the part that does not conform.
	expect(reading.values).toEqual({ theme: null });
	expect(reading.issues).toEqual([
		{ field: 'window', path: '/width', message: expect.any(String) },
	]);

	// Reading follows JSON.parse, and a byte order mark is not part of the JSON.
	expect(kv.inspect(`${BOM}{"theme": "a", "th\\u0065me": "b"}`)).toEqual({
		values: { theme: 'b' },
		parseError: undefined,
		issues: [],
	});
});

test('a reading is frozen at every depth, and two readings share nothing', async () => {
	const { kv } = await setup();
	const source = '{"layout": {"panes": [1, {"deep": [2]}]}, "size": "x"}';
	for (const reading of [kv.inspect(source), kv.inspect('{"theme": ')]) {
		const nodes = nodesOf(reading);
		expect(nodes.length).toBeGreaterThan(3);
		for (const node of nodes) expect(Object.isFrozen(node)).toBe(true);
	}
	const layout = kv.inspect(source).values.layout as { panes: unknown[] };
	expect(() => layout.panes.push(3)).toThrow(TypeError);
	expect(kv.inspect(source).values.layout).not.toBe(layout);
});

/** What `Type.Refine` adds to a schema, written out: this package does not depend on TypeBox. */
const refined = <TSchema extends object>(
	schema: TSchema,
	refine: (value: unknown) => boolean,
) => ({ ...schema, '~refine': [{ refine, message: 'refused' }] });

const refining = defineFolder({
	kv: {
		theme: { type: 'string' },
		// A refinement may freeze the value it is shown, and only that value.
		layout: refined({ type: 'object' }, (value) => {
			Object.freeze(value);
			return true;
		}),
		// Tries to change the value it is shown.
		mutated: refined({ type: 'object' }, (value) => {
			if (value !== null) (value as { answer: number }).answer = 99;
			return true;
		}),
		// Throws on one value and admits every other.
		guard: refined({ type: 'string' }, (value) => {
			if (value === 'boom') throw new Error('the refinement threw');
			return true;
		}),
	},
	tables: {},
});

test('a supplied key named __proto__ is an undeclared key like any other: refused by name, and nothing is saved', async () => {
	// As parsed JSON carries it: an own key, not the object's prototype.
	const values = JSON.parse('{"theme": "dark", "__proto__": {"extra": 1}}');
	const refusedBy = {
		field: '__proto__',
		message: '__proto__ is not declared',
	};

	const empty = await setup();
	const created = expectErr(await empty.kv.create(values));
	expect(created.name).toBe('InvalidValues');
	if (created.name === 'InvalidValues')
		expect(created.issues).toEqual([refusedBy]);
	expect(expectOk(await empty.kv.get())).toBeUndefined();

	const before = '{"theme": "light"}';
	const existing = await setup(before);
	const updated = expectErr(await existing.kv.update(values));
	expect(updated.name).toBe('InvalidValues');
	if (updated.name === 'InvalidValues')
		expect(updated.issues).toEqual([refusedBy]);
	expect(await existing.source()).toBe(before);
	expect(existing.calls.applies).toBe(0);
});

test('a refinement is shown a frozen copy: the supplied objects stay unfrozen, and one that changes its value is an issue', async () => {
	const { storage, files, source } = await setup();
	const kv = createKv<{
		theme: string;
		layout: { panes: number[] };
		mutated: { answer: number };
	}>({ storage }, refining.kv);
	const supplied = { layout: { panes: [1] } };
	const created = expectOk(await kv.create(supplied));
	for (const node of nodesOf(supplied))
		expect(Object.isFrozen(node)).toBe(false);
	supplied.layout.panes.push(2);
	expect(created.values.layout).toEqual({ panes: [1] });

	// Copying would flatten this into a plain object the field accepts.
	class Box {
		panes = [1];
	}
	expect(expectErr(await kv.update({ layout: new Box() as never })).name).toBe(
		'InvalidValues',
	);

	const change = { theme: 'dark', mutated: { answer: 1 } };
	const refused = expectErr(await kv.update(change));
	expect(refused.name).toBe('InvalidValues');
	if (refused.name === 'InvalidValues')
		expect(refused.issues.map((issue) => issue.field)).toEqual(['mutated']);
	expect(change).toEqual({ theme: 'dark', mutated: { answer: 1 } });
	expect(await source()).toBe(created.source);

	// The same value in a file somebody wrote: it reads with the issue, the
	// key beside it still reads and updates, and the text stays as written.
	const written = '{"theme": "light", "mutated": {"answer": 1}}';
	expectOk(await files.replace(created, written));
	const read = expectOk(await kv.get())!;
	expect(read.source).toBe(written);
	expect(read.values).toEqual({ theme: 'light' });
	expect(read.issues.map((issue) => issue.field)).toEqual(['mutated']);
	const updated = expectOk(await kv.update({ theme: 'dark' }));
	expect(updated.source).toBe(written.replace('light', 'dark'));
	expect(await source()).toBe(updated.source);
	expect(updated.issues.map((issue) => issue.field)).toEqual(['mutated']);
});

test('a value its refinement froze still has every child frozen', async () => {
	const { storage } = await setup();
	const kv = createKv<{ layout: { panes: unknown[] } }>(
		{ storage },
		refining.kv,
	);
	const reading = kv.inspect('{"layout": {"panes": [1, {"deep": [2]}]}}');
	expect(reading.issues).toEqual([]);
	const nodes = nodesOf(reading);
	expect(nodes.length).toBeGreaterThan(5);
	for (const node of nodes) expect(Object.isFrozen(node)).toBe(true);
	const panes = reading.values.layout?.panes as unknown[];
	expect(() => panes.push(3)).toThrow(TypeError);
});

test('a stored value whose refinement throws is an issue, and another key still updates beside it', async () => {
	const before = '{"guard": "boom", "theme": "light"}';
	const { storage, source } = await setup(before);
	const kv = createKv<{ theme: string; guard: string }>(
		{ storage },
		refining.kv,
	);
	const read = expectOk(await kv.get())!;
	expect(read.values).toEqual({ theme: 'light' });
	expect(read.issues.map((issue) => issue.field)).toEqual(['guard']);

	// The supplied value conforms; the stored one beside it stays as written.
	const updated = expectOk(await kv.update({ theme: 'dark' }));
	expect(await source()).toBe('{"guard": "boom", "theme": "dark"}');
	expect(updated.values).toEqual({ theme: 'dark' });
	expect(updated.issues.map((issue) => issue.field)).toEqual(['guard']);
	// The value itself is still refused as input.
	expect(expectErr(await kv.update({ guard: 'boom' })).name).toBe(
		'InvalidValues',
	);
});

test('a receipt is prepared before publication: an interpreter that fails leaves kv.json as it was', async () => {
	const before = '{"size": 1, "theme": "light"}';
	const { storage, calls, source } = await setup(before);
	// No declared field does this; it stands for a failure nobody planned for.
	// Supplied values are checked first, so only reading the stored `size` fails.
	const kv = createKv<Values>(
		{ storage },
		new Proxy(definition.kv, {
			get(fields, key, receiver) {
				if (key === 'size') throw new Error('the interpreter failed');
				return Reflect.get(fields, key, receiver);
			},
		}),
	);
	await expect(kv.update({ theme: 'dark' })).rejects.toThrow(
		'the interpreter failed',
	);
	expect(calls).toEqual({ reads: 1, applies: 0 });
	expect(await source()).toBe(before);
});

test('declared keys that every object inherits are read only when the file has them', async () => {
	const inherited = defineFolder({
		kv: { constructor: field.string(), toString: field.string() },
		tables: {},
	});
	const { storage } = await setup('{"theme": "dark"}');
	const kv = createKv<Record<string, string>>({ storage }, inherited.kv);
	const snapshot = expectOk(await kv.get());
	expect(Object.keys(snapshot?.values ?? {})).toEqual([]);
	expect(snapshot?.issues).toEqual([]);

	const updated = expectOk(
		await kv.update({ constructor: 'mine', toString: 'text' }),
	);
	expect(updated.source).toBe(
		'{"theme": "dark","constructor": "mine","toString": "text"}',
	);
	expect(Object.entries(updated.values)).toEqual([
		['constructor', 'mine'],
		['toString', 'text'],
	]);
});

// ============================================================================
// create
// ============================================================================

test('create saves only the supplied values as two-space JSON and reads nothing', async () => {
	const { kv, calls, source } = await setup();
	const created = expectOk(
		await kv.create({ theme: 'dark', layout: { panes: [1, 2] } }),
	);
	const text =
		'{\n  "theme": "dark",\n  "layout": {\n    "panes": [\n      1,\n      2\n    ]\n  }\n}\n';
	expect(created.source).toBe(text);
	expect(await source()).toBe(text);
	expect(created.sha256).toBe(await hashBytes(encoder.encode(text)));
	expect(created.values).toEqual({ theme: 'dark', layout: { panes: [1, 2] } });
	expect(created).toMatchObject({ parseError: undefined, issues: [] });
	// The receipt is the reading of the submitted text, with no read made.
	expect(readingOf(created)).toEqual(kv.inspect(text));
	expect(calls).toEqual({ reads: 0, applies: 1 });
	expect(expectOk(await kv.get())).toEqual(created);
});

test('supplied values are copied: the caller keeps mutable objects, and snapshot values go back in', async () => {
	const { kv } = await setup();
	const layout = { panes: [1, 2] };
	const supplied = { theme: 'dark', layout };
	const created = expectOk(await kv.create(supplied));
	expect(Object.isFrozen(supplied)).toBe(false);
	expect(Object.isFrozen(layout)).toBe(false);
	expect(Object.isFrozen(layout.panes)).toBe(false);
	expect(created.values.layout).toEqual(layout);
	expect(created.values.layout).not.toBe(layout);
	// The caller's later change does not reach the receipt.
	layout.panes.push(3);
	expect(created.values.layout).toEqual({ panes: [1, 2] });

	// Frozen snapshot values are accepted as they are and saved as new copies.
	const updated = expectOk(await kv.update(created.values));
	expect(updated.values).toEqual(created.values);
	expect(updated.values.layout).not.toBe(created.values.layout);
});

test('create is refused as Exists when another writer made the file first', async () => {
	const { kv, files, calls, source } = await setup();
	// The file appears after the caller saw it missing.
	expect(expectOk(await kv.get())).toBeUndefined();
	expectOk(await files.create('kv.json', '{"theme": "theirs"}'));

	expect(expectErr(await kv.create({ theme: 'mine' })).name).toBe('Exists');
	expect(await source()).toBe('{"theme": "theirs"}');
	expect(calls.applies).toBe(1);
});

test('a reference and an unannotated schema are kv fields, and an identifier may dangle', async () => {
	const references = defineFolder({
		kv: {
			home: field.nullable(field.reference('pages')),
			// A native schema with no editor hint.
			window: {
				type: 'object',
				properties: { width: { type: 'integer' } },
				required: ['width'],
			},
		},
		tables: {},
	});
	const environment = { indexedDB: new IDBFactory(), IDBKeyRange };
	const db = await openFolderDatabase('epicenter-folder:kv-refs', environment);
	const kv = createKv<KvOf<typeof references>>(
		{ storage: createBrowserFileBoundary(db, environment) },
		references.kv,
	);

	// No `pages` table exists, and nothing looks for the row.
	const created = expectOk(
		await kv.create({ home: 'no-such-page', window: { width: 800 } }),
	);
	expect(created.values).toEqual({
		home: 'no-such-page',
		window: { width: 800 },
	});
	expect(created.issues).toEqual([]);

	// The schemas still decide what is saved, and say where a value fails.
	const empty = expectErr(await kv.update({ home: '' }));
	if (empty.name !== 'InvalidValues') throw new Error('expected InvalidValues');
	// One value can fail in several ways; every issue names its field.
	expect(empty.issues.length).toBeGreaterThan(0);
	for (const issue of empty.issues) expect(issue.field).toBe('home');
	expect(expectErr(await kv.update({ window: { width: 1.5 } }))).toMatchObject({
		name: 'InvalidValues',
		issues: [{ field: 'window', path: '/width' }],
	});
	expect(expectOk(await kv.update({ home: null })).values).toEqual({
		home: null,
		window: { width: 800 },
	});
});

// ============================================================================
// update
// ============================================================================

test('update refuses a missing file as NotFound and creates nothing', async () => {
	const { kv, files, calls } = await setup();
	expect(expectErr(await kv.update({ theme: 'dark' })).name).toBe('NotFound');
	expect(calls).toEqual({ reads: 1, applies: 0 });
	expect(expectErr(await files.read('kv.json')).name).toBe('NotFound');
});

test('update reads once, publishes once, and returns the capture of what it submitted', async () => {
	const { kv, calls, source } = await setup('{"theme": "light"}\n');
	const updated = expectOk(await kv.update({ theme: 'dark' }));
	expect(calls).toEqual({ reads: 1, applies: 1 });
	expect(updated.source).toBe('{"theme": "dark"}\n');
	expect(updated.sha256).toBe(await hashBytes(encoder.encode(updated.source)));
	expect(updated.values).toEqual({ theme: 'dark' });
	expect(await source()).toBe(updated.source);
});

test('update returns Conflict when the file changes after its one read, and does not retry', async () => {
	const { kv, files, calls, source, afterNextRead } =
		await setup('{"theme": "light"}');
	const theirs = '{"theme": "theirs", "other": true}';
	afterNextRead(async () => {
		const current = expectOk(await files.read('kv.json'));
		expectOk(await files.replace(current, theirs));
	});

	const conflict = expectErr(await kv.update({ theme: 'mine' }));
	expect(conflict.name).toBe('Conflict');
	expect(calls).toEqual({ reads: 1, applies: 1 });
	expect(await source()).toBe(theirs);
});

test('a nested value changed while the read is pending does not change what is saved', async () => {
	const { kv, source, afterNextRead } = await setup('{"theme": "light"}');
	const layout = { panes: [1, 2], split: { ratio: 0.5 } };
	const values = { layout, theme: 'dark' };
	afterNextRead(async () => {
		layout.panes.push(3);
		layout.split.ratio = 0.9;
		values.theme = 'changed';
	});

	const updated = expectOk(await kv.update(values));
	expect(updated.values).toEqual({
		theme: 'dark',
		layout: { panes: [1, 2], split: { ratio: 0.5 } },
	});
	expect(await source()).toBe(
		'{"theme": "dark","layout": {"panes":[1,2],"split":{"ratio":0.5}}}',
	);
});

test.each([
	['an undeclared key', { language: 'en' }],
	['a value of the wrong type', { theme: 12 }],
	['an undefined value', { theme: undefined }],
	['Infinity', { size: Number.POSITIVE_INFINITY }],
	['NaN', { size: Number.NaN }],
	['a nested non-finite number', { layout: { ratio: Number.NaN } }],
	['a nested undefined', { layout: { ratio: undefined } }],
	['a Date', { layout: new Date(0) }],
	['a function', { layout: { run() {} } }],
	// biome-ignore lint/suspicious/noSparseArray: a hole serializes as null.
	['an array hole', { layout: [1, , 3] }],
])('create and update refuse %s as InvalidValues and write nothing', async (_name, values) => {
	const { kv, calls, source } = await setup('{"theme": "light"}');
	const supplied = values as Partial<Values>;
	expect(expectErr(await kv.update(supplied)).name).toBe('InvalidValues');
	expect(expectErr(await kv.create(supplied)).name).toBe('InvalidValues');
	expect(calls).toEqual({ reads: 0, applies: 0 });
	expect(await source()).toBe('{"theme": "light"}');
});

test.each([
	[
		'an object wider than the budget',
		Object.fromEntries(
			Array.from({ length: 1025 }, (_, index) => [`key${index}`, index]),
		),
	],
	['nesting deeper than the budget', [[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]],
])('create and update refuse %s by naming the budget, not conformance', async (_name, layout) => {
	const { kv, calls, source } = await setup('{"theme": "light"}');
	// The field itself takes the value: it is JSON, and JSON has no size.
	expect(accepts(definition.kv.layout, layout)).toBe(true);

	const supplied = { layout } as Partial<Values>;
	for (const refused of [await kv.update(supplied), await kv.create(supplied)])
		expect(expectErr(refused)).toMatchObject({
			name: 'InvalidValues',
			issues: [
				{
					field: 'layout',
					message:
						'layout is over the kv.json budget: nesting deeper than 16 levels, or an object with more than 1024 keys',
				},
			],
		});
	expect(calls).toEqual({ reads: 0, applies: 0 });
	expect(await source()).toBe('{"theme": "light"}');
});

// ============================================================================
// What an update leaves alone
// ============================================================================

test('update keeps a byte order mark, number spellings, nesting, and spacing outside the value it assigns', async () => {
	const before = `${BOM}{\r\n\t"big" : 9007199254740993,\r\n\t"huge":1e400,\r\n\t"th\\u0065me"  :  "light" ,\r\n\t"nested": { "a" : [ 1,2 , {"b":null} ], "theme": "inner" },\r\n\t"size": 1.50\r\n}\r\n`;
	const { kv, source } = await setup(before);

	const updated = expectOk(await kv.update({ theme: 'dark' }));
	const after = before.replace('"light"', '"dark"');
	expect(updated.source).toBe(after);
	expect(await source()).toBe(after);
	expect(updated.source.startsWith(BOM)).toBe(true);
	expect(updated.values).toEqual({ theme: 'dark', size: 1.5 });
	expect(updated.issues).toEqual([]);
});

test('update leaves a declared value it was not given exactly as written, valid or not', async () => {
	const { kv } = await setup('{"size": "1e2", "theme": "light"}');
	const updated = expectOk(await kv.update({ theme: 'dark' }));
	expect(updated.source).toBe('{"size": "1e2", "theme": "dark"}');
	expect(updated.values).toEqual({ theme: 'dark' });
	expect(updated.issues.map((issue) => issue.field)).toEqual(['size']);
});

test('update refuses a supplied key that appears twice as UnsupportedSource, though the file reads', async () => {
	for (const before of [
		'{"theme": "a", "theme": "b"}',
		'{"theme": "a", "th\\u0065me": "b"}',
	]) {
		const { kv, calls, source } = await setup(before);
		// The text parses, so reading it is not the problem: patching it is.
		expect(expectOk(await kv.get())).toMatchObject({
			values: { theme: 'b' },
			parseError: undefined,
		});
		const refused = expectErr(await kv.update({ theme: 'dark' }));
		expect(refused.name).toBe('UnsupportedSource');
		expect(refused.message).toContain("'theme'");
		expect(calls.applies).toBe(0);
		expect(await source()).toBe(before);
		// A key that appears once is still assignable in the same file.
		expect(expectOk(await kv.update({ size: 2 })).values).toEqual({
			theme: 'b',
			size: 2,
		});
	}
});

test('update keeps unknown keys that appear twice, with their number spellings', async () => {
	const before =
		'{"other": 1.0, "theme": "light", "other": {"n": 1e400, "big": 9007199254740993}, "__proto__": {"x": 1}}';
	const { kv } = await setup(before);
	const updated = expectOk(await kv.update({ theme: 'dark' }));
	expect(updated.source).toBe(before.replace('"light"', '"dark"'));
	// Undeclared keys are never values or issues.
	expect(updated).toMatchObject({ values: { theme: 'dark' }, issues: [] });
});

test.each([
	[
		'an indented object',
		'{\n  "other": 1\n}\n',
		'{\n  "other": 1,\n  "theme": "dark",\n  "size": 2\n}\n',
	],
	['a compact object', '{"other":1}', '{"other":1,"theme":"dark","size":2}'],
	['an empty object', '{ }\n', '{\n  "theme": "dark",\n  "size": 2\n}\n'],
])('update adds several missing keys to %s as valid JSON', async (_name, before, after) => {
	const { kv, source } = await setup(before);
	const updated = expectOk(await kv.update({ theme: 'dark', size: 2 }));
	expect(updated.source).toBe(after);
	expect(await source()).toBe(after);
	expect(JSON.parse(updated.source)).toMatchObject({ theme: 'dark', size: 2 });
	expect(updated.values).toEqual({ theme: 'dark', size: 2 });
});

test('update replaces one key and adds another in the same publication', async () => {
	const { kv, calls } = await setup('{\n  "size": 1\n}\n');
	const updated = expectOk(await kv.update({ theme: 'dark', size: 22 }));
	expect(updated.source).toBe('{\n  "size": 22,\n  "theme": "dark"\n}\n');
	expect(calls.applies).toBe(1);
});

// ============================================================================
// Source that cannot be patched
// ============================================================================

test.each([
	['malformed JSON', '{"theme": "light"'],
	['a comment', '{/* note */ "theme": "light"}'],
	['a trailing comma', '{"theme": "light",}'],
	['a JSON array', '["light"]'],
	['an empty file', ''],
])('update refuses %s as Unparsed with the parse error a read reports, and files.replace repairs it', async (_name, before) => {
	const { kv, files, calls, source } = await setup(before);
	const refused = expectErr(await kv.update({ theme: 'dark' }));
	expect(refused.name).toBe('Unparsed');
	expect(calls.applies).toBe(0);
	expect(await source()).toBe(before);

	// The snapshot is the capture a complete replacement is saved against.
	const snapshot = expectOk(await kv.get());
	if (snapshot === undefined) throw new Error('kv.json is missing');
	if (refused.name !== 'Unparsed') throw new Error('expected Unparsed');
	expect(refused.path).toBe('kv.json');
	expect(snapshot.parseError).toEqual(refused.error);
	expectOk(await files.replace(snapshot, '{"theme": "light"}'));
	expect(expectOk(await kv.update({ theme: 'dark' })).source).toBe(
		'{"theme": "dark"}',
	);

	// The capture that was repaired no longer matches the file.
	expect(expectErr(await files.replace(snapshot, '{}')).name).toBe('Conflict');
});
