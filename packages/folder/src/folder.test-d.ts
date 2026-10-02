/**
 * A folder reads its tables and KV through the declaration's own lenses, and
 * every acquisition entry exports one opener signature and one contract.
 */
import { expectTypeOf } from 'bun:test';
import type { InstantString } from '@epicenter/definition/field';
import type { Result } from 'wellcrafted/result';
import * as browser from './browser.js';
import * as bun from './bun.js';
import type * as contract from './contract.js';
import * as root from './index.js';
import {
	type BatchReceipt,
	type CapturedFile,
	type CreateRowOf,
	defineFolder,
	defineTable,
	type FileCapture,
	type FileKv,
	type FileTable,
	type Folder,
	type FolderLocation,
	type FolderTerminal,
	field,
	type KvOf,
	type KvSnapshot,
	type OpenFolder,
	type OpenFolderError,
	type OpenFolderOptions,
	type TextCapture,
} from './index.js';
import * as tauri from './tauri.js';

const definition = defineFolder({
	id: 'test.folder',
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

// Every entry exports the same contract, so a build may resolve one for another.
type Contract = typeof contract;
type Entry<T> = Omit<T, 'openFolder'>;
expectTypeOf<Entry<typeof root>>().toEqualTypeOf<Contract>();
expectTypeOf<Entry<typeof browser>>().toEqualTypeOf<Contract>();
expectTypeOf<Entry<typeof tauri>>().toEqualTypeOf<Contract>();
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
	expectTypeOf(snapshot.values).toEqualTypeOf<Readonly<{ theme?: string }>>();
	const observed = await folder.kv.get();
	if (observed.error === null)
		expectTypeOf(observed.data).toEqualTypeOf<
			KvSnapshot<KvOf<typeof definition>> | undefined
		>();
	folder.files.replace(snapshot, '{}');

	// Captures are plain values; a read also carries detached bytes.
	const read = await folder.files.read('a.md');
	if (read.error) return;
	expectTypeOf(read.data).toEqualTypeOf<CapturedFile>();
	const replaced = await folder.files.replace(read.data, 'next');
	if (replaced.error) return;
	expectTypeOf(replaced.data).toEqualTypeOf<FileCapture>();
	expectTypeOf(await folder.files.remove(replaced.data)).toEqualTypeOf<
		Awaited<ReturnType<Opened['files']['remove']>>
	>();
	// A table entry is a capture of its row file.
	const entry = await folder.tables.todos.get('milk');
	folder.tables.todos.update('milk', {
		fields: { title: 'Next' },
		body: 'body',
	});
	// @ts-expect-error Updates name an ID, not a captured baseline.
	folder.tables.todos.update(entry.data, { fields: { title: 'Next' } });
	// @ts-expect-error Structured commands still validate the supplied field types.
	folder.tables.todos.update('milk', { fields: { title: 12 } });
	if (entry.data) {
		folder.files.replace(entry.data, entry.data.source);
		folder.tables.todos.replace(entry.data, entry.data.source);
		// @ts-expect-error Complete replacements require a captured baseline.
		folder.tables.todos.replace('milk', entry.data.source);
		// @ts-expect-error The old source-write spelling is removed.
		folder.tables.todos.writeSource(entry.data, entry.data.source);
	}
	folder.tables.todos.replace(replaced.data, 'next');
	folder.tables.todos.delete(replaced.data);
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

	// A batch callback collects and returns undefined.
	const receipt = await folder.batch((batch) => {
		batch.files.create('audio/a.webm', new Uint8Array());
		batch.tables.todos.create({
			stem: 'a',
			fields: { title: 'A', due: null },
		});
		// @ts-expect-error A batched row names its stem.
		batch.tables.todos.create({ fields: { title: 'A', due: null } });
		// @ts-expect-error The collector has no reads.
		batch.files.read('a.md');
		// @ts-expect-error The collector mirrors only row creation.
		batch.tables.todos.update;
	});
	if (receipt.error === null)
		expectTypeOf(receipt.data).toEqualTypeOf<BatchReceipt>();
	// @ts-expect-error A batch callback is not asynchronous.
	folder.batch(async () => {});
	// @ts-expect-error A batch callback returns nothing.
	folder.batch(() => 1);

	expectTypeOf(folder.location).toEqualTypeOf<FolderLocation>();
	expectTypeOf(folder.terminal()).toEqualTypeOf<FolderTerminal>();
	expectTypeOf(folder.onFilesChanged(() => {})).toEqualTypeOf<() => void>();
}
void typedValues;

// A table with a body conversion is not a folder table.
defineFolder({
	id: 'test.body',
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
	id: 'test.bare',
	kv: {},
	tables: {
		// @ts-expect-error A table is authored with `defineTable`.
		notes: { fields: { title: field.string() } },
	},
});
