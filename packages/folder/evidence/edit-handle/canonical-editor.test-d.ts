/**
 * Canonical editor call-site types (EXPERIMENT). Checked by `tsc`, never run.
 *
 * A structured change names declared fields only, but holds any canonical
 * value so intermediate input can be schema invalid. The local document is
 * not narrowed to the row type; `reading.fields` is the validated view.
 */
import { defineFolder, defineTable, field } from '../../src/contract.js';
import {
	type CanonicalEditorFolder,
	createCanonicalEditors,
} from './canonical-editor.js';

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

declare const folder: CanonicalEditorFolder<typeof definition>;
const editors = createCanonicalEditors(folder, definition);

export async function callSite() {
	const { data: editor, error } = await editors.tables.todos.edit('plan');
	if (error !== null) return;
	const { change, get } = editor;

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

	// @ts-expect-error only declared tables have editors
	editors.tables.notes;
}
