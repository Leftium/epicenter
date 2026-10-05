/**
 * Row editor call-site types. Checked by `tsc`, never run.
 *
 * The table owns its editor, so its row type comes from the definition the
 * folder was opened with. A valid row types its declared fields and keeps
 * unknown metadata. `set` takes any complete unvalidated row, so a valid
 * row's fields can be spread back with changes, and schema-invalid values
 * can be held while a person types.
 */
import { expectTypeOf } from 'bun:test';
import type { Result } from 'wellcrafted/result';
import {
	type CanonicalValue,
	type CreateRowOf,
	defineFolder,
	defineTable,
	type Folder,
	field,
	type RowEditor,
	type RowError,
	type RowReloadError,
	type RowSaveError,
	type RowSetError,
	type TableEditError,
} from './contract.js';

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: {
				title: field.string({ minLength: 1 }),
				done: field.boolean(),
				priority: field.select(['low', 'normal', 'high']),
			},
		}),
	},
});
type Todo = CreateRowOf<typeof definition.tables.todos>;

declare const folder: Folder<typeof definition>;

export async function callSite() {
	const opened = await folder.tables.todos.edit('plan', {
		signal: AbortSignal.timeout(1000),
	});
	expectTypeOf(opened).toEqualTypeOf<Result<RowEditor<Todo>, TableEditError>>();
	const { data: editor, error } = opened;
	if (error !== null) {
		switch (error.name) {
			case 'Aborted':
			case 'NotFound':
			case 'InvalidUtf8':
				break;
		}
		return;
	}
	const { get, set, setText, retry, waitForSaves, reload, subscribe } = editor;

	const { row, save } = get();
	switch (row.status) {
		case 'valid': {
			row.fields.title satisfies string;
			row.fields.priority satisfies 'low' | 'normal' | 'high';
			// Unknown metadata is kept and readable as canonical values.
			row.fields.owner satisfies CanonicalValue | undefined;
			row.text satisfies string;
			row.body satisfies string;
			// A whole-row spread with one field changed.
			set({ fields: { ...row.fields, title: 'Plan' }, body: row.body });
			// A public valid row can be passed back; its status and text are ignored.
			set(row);
			// @ts-expect-error a snapshot is not writable
			row.fields.title = 'Plan';
			break;
		}
		case 'invalid':
			row.error satisfies RowError;
			setText(row.text);
			// @ts-expect-error an invalid row has no structured fields
			row.fields;
			break;
		default:
			row satisfies never;
	}
	// Every row exposes its text; storage never hides it.
	row.text satisfies string;
	// @ts-expect-error there is no unreadable row
	row.status === 'unreadable';
	if (save.status === 'failed') save.error satisfies RowSaveError;

	// Complete unvalidated input: schema-invalid and undeclared values hold.
	expectTypeOf(
		set({ fields: { title: '', priority: 'urgent', owner: 'sam' }, body: '' }),
	).toEqualTypeOf<Result<undefined, RowSetError>>();
	// @ts-expect-error a function has no canonical form
	set({ fields: { title: () => 'Plan' }, body: '' });
	// @ts-expect-error a complete row names its body
	set({ fields: {} });

	expectTypeOf(setText('---\n---\n')).toEqualTypeOf<void>();
	expectTypeOf(retry()).toEqualTypeOf<void>();
	expectTypeOf(waitForSaves()).toEqualTypeOf<
		Promise<Result<undefined, RowSaveError>>
	>();
	expectTypeOf(reload()).toEqualTypeOf<
		Promise<Result<undefined, RowReloadError>>
	>();
	const { error: reloadError } = await reload();
	if (reloadError !== null) {
		switch (reloadError.name) {
			case 'InputChanged':
			case 'NotFound':
			case 'InvalidUtf8':
				break;
		}
	}
	expectTypeOf(subscribe(() => {})).toEqualTypeOf<() => void>();

	// @ts-expect-error the retired protocol is gone
	editor.change;
	// @ts-expect-error reload replaced observation
	editor.refresh;
	// @ts-expect-error there is no disposal protocol
	editor.dispose;
	// @ts-expect-error waitForSaves replaced flush
	editor.flush;

	// @ts-expect-error only declared tables have editors
	folder.tables.notes.edit('plan');
}
