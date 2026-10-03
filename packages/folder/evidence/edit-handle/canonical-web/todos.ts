/**
 * The definition, folder ID, and seed rows of the canonical editor demo.
 *
 * `title` has a minimum length so that typing toward a valid title shows
 * schema issues without erasing the draft: `A` stays drafted on the way to
 * `ABC`, and only `save` refuses it.
 */
import {
	type CreateRowOf,
	defineFolder,
	defineTable,
	field,
	rowPath,
} from '../../../src/browser.js';

/**
 * The demo's own disposable folder. Every tab and reload on this origin opens
 * the same one, so saves persist and other tabs hear them.
 */
export const DEMO_FOLDER_ID = 'so.epicenter.evidence.canonical-editor';

/** The options a priority control offers, in order. */
export const PRIORITIES = ['low', 'normal', 'high'] as const;

export const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: {
				title: field.string({ minLength: 3 }),
				done: field.boolean(),
				priority: field.select(PRIORITIES),
			},
		}),
	},
});

export type TodoRow = CreateRowOf<(typeof definition)['tables']['todos']>;

/**
 * The rows a person can open. `plan` opens; the others show each way opening
 * can refuse, and the raw repair that follows.
 */
export const STEMS = {
	plan: 'Hand-formatted valid row',
	tagged: 'Custom YAML tag: no canonical form',
	urgent: 'Priority outside the declared options',
	gone: 'No file',
} as const;
export type Stem = keyof typeof STEMS;

export const todoPath = (stem: string) => rowPath('todos', stem);

/** The text of a new valid row, for creating a file that is not there. */
export const NEW_ROW =
	'---\ntitle: New todo\ndone: false\npriority: normal\n---\n';

/**
 * The rows a folder with no todos starts with, and what Reset writes back.
 * `plan.md` is valid but not canonical: a comment, single quotes, keys out of
 * declared order, and two keys the table does not declare. A canonical save
 * drops the comment and the quoting and keeps every value, `owner` and
 * `labels` included. `gone` is not seeded.
 */
export const SEED: Readonly<Record<string, string>> = {
	[todoPath('plan')]: [
		'---',
		'# Written by hand. A canonical save drops this comment.',
		'priority: normal',
		'owner: sam',
		"title: 'Plan the launch'",
		'labels:',
		'  - launch',
		'  - q4',
		'done: false',
		'---',
		'Draft the announcement and the checklist.',
		'',
	].join('\n'),
	[todoPath('tagged')]: [
		'---',
		'title: Tagged owner',
		'done: false',
		'priority: low',
		'owner: !person sam',
		'---',
		'',
	].join('\n'),
	[todoPath('urgent')]: [
		'---',
		'title: Fix the build',
		'done: false',
		'priority: urgent',
		'---',
		'',
	].join('\n'),
};
