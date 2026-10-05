/**
 * The definition, folder ID, and seed rows of the row editor demo.
 *
 * `title` has a minimum length so that a schema-invalid value is easy to
 * type: a one-letter title is still a row the editor can represent, so it is
 * accepted and saved as typed. The row is then `invalid`, and every view
 * shows its Markdown source with the issue until a person repairs it.
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
 * The rows a person can open. `plan` and `crlf` are valid; `tagged` and
 * `urgent` open as invalid rows for repair in the same editor; `gone` has no
 * file, so opening it returns `NotFound` and no editor.
 */
export const STEMS = {
	plan: 'Hand-formatted valid row',
	crlf: 'Valid row with CRLF line endings',
	tagged: 'Custom YAML tag: no canonical form',
	urgent: 'Priority outside the declared options',
	gone: 'No file',
} as const;
export type Stem = keyof typeof STEMS;

export const todoPath = (stem: string) => rowPath('todos', stem);

/** The text the raw file panel writes for a path that has no seed text. */
export const NEW_ROW =
	'---\ntitle: New todo\ndone: false\npriority: normal\n---\n';

/**
 * The rows a folder with no todos starts with, and what Reset writes back.
 * `plan.md` is valid but not canonical: a comment, single quotes, keys out of
 * declared order, and two keys the table does not declare. A structured edit
 * writes the whole row canonically: the comment and the quoting go, and every
 * value stays, `owner` and `labels` included. `crlf.md` uses CRLF line
 * endings: a structured edit keeps them in the body and writes the header in
 * LF, and a source edit writes CRLF on every line. `gone` is not seeded.
 */
export const SEED: Readonly<Record<string, string>> = {
	[todoPath('plan')]: [
		'---',
		'# Written by hand. A structured edit drops this comment.',
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
	[todoPath('crlf')]: [
		'---',
		'title: Written on Windows',
		'done: false',
		'priority: low',
		'---',
		'First line.',
		'Second line.',
		'',
	].join('\r\n'),
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
