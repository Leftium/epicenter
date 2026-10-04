/**
 * Row editor call-site types. Checked by `tsc`, never run.
 *
 * The table owns its editor, so its row type comes from the definition the
 * folder was opened with. A structured change names declared fields only,
 * but holds any canonical value so intermediate input can be schema invalid.
 * The local document is not narrowed to the row type; `reading.fields` is
 * the validated view.
 */
import { expectTypeOf } from 'bun:test';
import type { Result } from 'wellcrafted/result';
import {
	type CreateRowOf,
	defineFolder,
	defineTable,
	type Folder,
	field,
	type RowEditor,
	type RowRevision,
	type RowSaveError,
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
			case 'NoCanonicalForm':
			case 'InvalidSource':
				// Both refusals carry the exact text for raw repair.
				error.file.text satisfies string;
				break;
			case 'Aborted':
			case 'NotFound':
				break;
		}
		return;
	}
	const { change, get, save } = editor;

	// Declared fields with conforming values.
	change({ fields: { title: 'Plan', done: true, priority: 'high' } });
	// Declared fields holding values the schema rejects, while a person types.
	change({ fields: { title: '' } });
	change({ fields: { priority: 'urgent' } });
	change({ fields: { done: 'yes' } });
	// Removing a declared field.
	change({ fields: { priority: undefined } });
	change({ body: 'Body.\n' });

	// @ts-expect-error a misspelled field does not compile
	change({ fields: { titel: 'Plan' } });
	// @ts-expect-error unknown metadata is kept but not structured-editable
	change({ fields: { owner: 'sam' } });
	// @ts-expect-error a function has no canonical form
	change({ fields: { title: () => 'Plan' } });

	const { document, reading } = get();
	// @ts-expect-error the local document is not guaranteed to conform
	document.fields.title satisfies string;
	reading.fields.title satisfies string | undefined;
	reading.fields.priority satisfies 'low' | 'normal' | 'high' | undefined;
	// @ts-expect-error state is a snapshot, not a writable store
	get().isDirty = false;

	expectTypeOf(await save()).toEqualTypeOf<Result<RowRevision, RowSaveError>>();

	// @ts-expect-error only declared tables have editors
	folder.tables.notes.edit('plan');
}
