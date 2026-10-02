/**
 * KV Tests
 *
 * `folder.kv` reads, creates, and updates the root `kv.json`. These drive the
 * KV methods and the ordinary file methods over one browser storage, so what
 * a method reads and publishes can be counted and held.
 *
 * Key behaviors:
 * - `get` returns `undefined` only for a missing file; unreadable bytes are an
 *   error, and readable text that is not a JSON object is a snapshot with issues
 * - `create` validates the supplied keys, reads nothing, and never replaces
 * - `update` reads once, refuses a missing or unpatchable file, and publishes
 *   once against what it read
 * - Supplied values are owned when the method is called
 * - Everything outside an assigned value stays byte for byte
 * - Source that cannot be patched is repaired through `files.replace`
 *
 * See also:
 * - `browser.test.ts` and `close.test.ts` for history and close around a KV save
 */
import { expect, test } from 'bun:test';
import { jsonValue } from '@epicenter/definition';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { FolderStorage } from './boundary.js';
import {
	createBrowserFileBoundary,
	openFolderDatabase,
} from './browser-store.js';
import { hashBytes } from './capture.js';
import { defineFolder, field, type KvOf } from './contract.js';
import { compileFolderDefinition } from './definition.js';
import { createFiles } from './files.js';
import { createKv } from './kv.js';

const definition = defineFolder({
	id: 'so.epicenter.kvtest',
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
		kv: createKv<Values>(
			{ storage },
			expectOk(compileFolderDefinition(definition)).kv,
		),
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
		expectOk(compileFolderDefinition(definition)).kv,
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

test('get returns a text capture with the declared values that validated', async () => {
	const source = '{"theme": "dark", "size": "large", "other": [1]}';
	const { kv } = await setup(source);
	const snapshot = expectOk(await kv.get());
	expect(snapshot).toEqual({
		path: 'kv.json',
		sha256: await hashBytes(encoder.encode(source)),
		source,
		values: { theme: 'dark' },
		issues: [
			{
				field: 'size',
				message: 'The value does not conform to its number field',
			},
		],
	});
	expect(Object.isFrozen(snapshot)).toBe(true);
});

test.each([
	['malformed JSON', '{"theme": '],
	['a JSON array', '["dark"]'],
	['an empty file', ''],
])('get returns %s as a snapshot with an issue and no values', async (_name, source) => {
	const { kv } = await setup(source);
	const snapshot = expectOk(await kv.get());
	expect(snapshot?.source).toBe(source);
	expect(snapshot?.values).toEqual({});
	expect(snapshot?.issues).toHaveLength(1);
	expect(snapshot?.issues?.[0]?.field).toBeUndefined();
});

test('declared keys that every object inherits are read only when the file has them', async () => {
	const inherited = defineFolder({
		id: 'so.epicenter.kvinherited',
		kv: { constructor: field.string(), toString: field.string() },
		tables: {},
	});
	const { storage } = await setup('{"theme": "dark"}');
	const kv = createKv<Record<string, string>>(
		{ storage },
		expectOk(compileFolderDefinition(inherited)).kv,
	);
	const snapshot = expectOk(await kv.get());
	expect(Object.keys(snapshot?.values ?? {})).toEqual([]);
	expect(snapshot?.issues).toBeUndefined();

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
	expect(created.issues).toBeUndefined();
	expect(calls).toEqual({ reads: 0, applies: 1 });
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
	expect(updated.issues).toBeUndefined();
});

test('update leaves a declared value it was not given exactly as written, valid or not', async () => {
	const { kv } = await setup('{"size": "1e2", "theme": "light"}');
	const updated = expectOk(await kv.update({ theme: 'dark' }));
	expect(updated.source).toBe('{"size": "1e2", "theme": "dark"}');
	expect(updated.values).toEqual({ theme: 'dark' });
	expect(updated.issues?.map((issue) => issue.field)).toEqual(['size']);
});

test('update refuses a supplied key that appears twice, in either spelling, and names it', async () => {
	for (const before of [
		'{"theme": "a", "theme": "b"}',
		'{"theme": "a", "th\\u0065me": "b"}',
	]) {
		const { kv, calls, source } = await setup(before);
		const refused = expectErr(await kv.update({ theme: 'dark' }));
		expect(refused.name).toBe('UnsupportedSource');
		expect(refused.message).toContain("'theme'");
		expect(calls.applies).toBe(0);
		expect(await source()).toBe(before);
	}
});

test('update keeps unknown keys that appear twice', async () => {
	const { kv } = await setup(
		'{"other": 1, "theme": "light", "other": 2, "__proto__": {"x": 1}}',
	);
	const updated = expectOk(await kv.update({ theme: 'dark' }));
	expect(updated.source).toBe(
		'{"other": 1, "theme": "dark", "other": 2, "__proto__": {"x": 1}}',
	);
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
])('update refuses %s as UnsupportedSource, and files.replace repairs it', async (_name, before) => {
	const { kv, files, calls, source } = await setup(before);
	expect(expectErr(await kv.update({ theme: 'dark' })).name).toBe(
		'UnsupportedSource',
	);
	expect(calls.applies).toBe(0);
	expect(await source()).toBe(before);

	// The snapshot is the capture a complete replacement is saved against.
	const snapshot = expectOk(await kv.get());
	if (snapshot === undefined) throw new Error('kv.json is missing');
	expect(snapshot.issues).toHaveLength(1);
	expectOk(await files.replace(snapshot, '{"theme": "light"}'));
	expect(expectOk(await kv.update({ theme: 'dark' })).source).toBe(
		'{"theme": "dark"}',
	);

	// The capture that was repaired no longer matches the file.
	expect(expectErr(await files.replace(snapshot, '{}')).name).toBe('Conflict');
});
