/**
 * EXPERIMENT: the definition and seed files the edit-handle demo uses, shared
 * by the Bun server and the browser page.
 */
import { defineFolder, defineTable, field } from '../../src/contract.js';

/** The options a priority control offers, in order. */
export const PRIORITIES = ['low', 'normal', 'high'] as const;

export const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: {
				title: field.string(),
				done: field.boolean(),
				priority: field.select(PRIORITIES),
			},
		}),
	},
});

/** The row both shared panels and the second handle edit. */
export const FORM_STEM = 'plan';

/** A plain text file edited through `edits.files.edit`. */
export const NOTES_PATH = 'notes.txt';

/**
 * Every file a fresh demo folder starts with. `plan.md` carries a comment and
 * a key the table does not declare; structured changes must keep both.
 */
export const SEED: Readonly<Record<string, string>> = {
	'todos/plan.md': [
		'---',
		'# Seeded by the edit-handle demo. This comment must survive edits.',
		'title: Plan the launch',
		'done: false',
		'priority: normal',
		'owner: sam # not declared by the table; kept as written',
		'---',
		'Draft the announcement and the checklist.',
		'',
	].join('\n'),
	'todos/milk.md': [
		'---',
		'title: Buy milk',
		'done: false',
		'priority: low',
		'---',
		'',
	].join('\n'),
	[NOTES_PATH]: 'Plain text, edited through files.edit.\n',
};
