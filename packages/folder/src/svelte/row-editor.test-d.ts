/**
 * Svelte row editor call-site types. Checked by `tsc`, never run.
 *
 * The adapter names the native snapshot parts and commands: `row`, `save`,
 * `set`, `setText`, `retry`, `waitForSaves`, and `reload`, typed by the table's
 * definition. It adds
 * no read or command of its own, and the core and platform entries export
 * nothing from it.
 */
import { expectTypeOf } from 'bun:test';
import {
	type CreateRowOf,
	defineFolder,
	defineTable,
	type Folder,
	field,
	type RowEditor,
	type RowState,
	type SaveState,
} from '../contract.js';
import { fromRowEditor, type ReactiveRowEditor } from './row-editor.svelte.js';

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({ fields: { title: field.string() } }),
	},
});
type Todo = CreateRowOf<typeof definition.tables.todos>;

declare const folder: Folder<typeof definition>;

export async function callSite() {
	const { data: rowEditor, error } = await folder.tables.todos.edit('plan');
	if (error !== null) return;
	const editor = fromRowEditor(rowEditor);
	expectTypeOf(editor).toEqualTypeOf<ReactiveRowEditor<Todo>>();
	expectTypeOf<keyof typeof editor>().toEqualTypeOf<
		'row' | 'save' | 'set' | 'setText' | 'retry' | 'waitForSaves' | 'reload'
	>();
	expectTypeOf(editor.row).toEqualTypeOf<RowState<Todo>>();
	expectTypeOf(editor.save).toEqualTypeOf<SaveState>();
	expectTypeOf(editor.set).toEqualTypeOf<RowEditor<Todo>['set']>();
	expectTypeOf(editor.setText).toEqualTypeOf<RowEditor<Todo>['setText']>();
	expectTypeOf(editor.retry).toEqualTypeOf<RowEditor<Todo>['retry']>();
	expectTypeOf(editor.waitForSaves).toEqualTypeOf<
		RowEditor<Todo>['waitForSaves']
	>();
	expectTypeOf(editor.reload).toEqualTypeOf<RowEditor<Todo>['reload']>();

	const { row } = editor;
	if (row.status === 'valid') {
		row.fields.title satisfies string;
		editor.set({ fields: { ...row.fields, title: 'Plan' }, body: row.body });
	}
	// @ts-expect-error tracked parts are read-only
	editor.row = row;
	// @ts-expect-error the native snapshot read is not adapted
	editor.get;
	// @ts-expect-error subscriptions belong to tracking
	editor.subscribe;
	// @ts-expect-error there is no standalone text reader
	editor.text;
	// @ts-expect-error there is no value wrapper
	editor.current;
	// @ts-expect-error there is no disposal protocol
	editor.dispose;
}

// The core and platform entries export no adapter value.
type Entry =
	| typeof import('../index.js')
	| typeof import('../browser.js')
	| typeof import('../tauri.js')
	| typeof import('../bun.js')
	| typeof import('../file-browser.js');
type KeysOf<T> = T extends unknown ? keyof T : never;
type EntryExports = KeysOf<Entry>;
expectTypeOf<Extract<EntryExports, 'fromRowEditor'>>().toEqualTypeOf<never>();
expectTypeOf<
	Extract<EntryExports, 'openFolder'>
>().toEqualTypeOf<'openFolder'>();
