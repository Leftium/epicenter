/**
 * A note's text: its Markdown body for the rich-text view, the text a list
 * shows, and help for repairing a note's file as text.
 *
 * A structured note is a row editor's document: fields and a Markdown body.
 * The rich-text view and the Markdown view both edit that body through
 * `noteBody`; a save writes the whole document in its canonical form. A note
 * file the row editor cannot hold is repaired as text, and `repairFields` is
 * the one change made to that text here: a person asks for it.
 */
import { patchRowText, type TableReading } from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { instantNow, type NoteFields } from './data.js';
import { type BodyInspection, inspectNoteBody } from './editor/markdown.js';
import type { BodyDraft } from './editor/rich-session.js';
import type { RowSession } from './row-session.svelte.js';

export type RichAvailability =
	| {
			readonly editable: true;
			/** The body text the document was parsed from. */
			readonly body: string;
			readonly inspection: Extract<BodyInspection, { supported: true }>;
	  }
	| { readonly editable: false; readonly reasons: readonly string[] };

/**
 * Whether this body can be edited as rich text, and why not when it cannot:
 * the editor must be able to write it back as the Markdown it read.
 */
export function richAvailability(body: string): RichAvailability {
	const inspection = inspectNoteBody(body);
	if (!inspection.supported)
		return { editable: false, reasons: inspection.reasons };
	return { editable: true, body, inspection };
}

/**
 * The body for serialized rich text: blank lines at its start are kept, the
 * text ends with one line break, and CRLF line endings are kept when the body
 * uses them.
 */
export function bodyText(markdown: string, previousBody: string): string {
	const lead = /^(?:\r?\n)*/.exec(previousBody)?.[0] ?? '';
	const body = markdown === '' ? lead : `${lead}${markdown}\n`;
	return previousBody.includes('\r\n') ? body.replace(/\r?\n/g, '\r\n') : body;
}

/**
 * A note's body, as the rich-text and Markdown views edit it, in whichever
 * session holds the note now: a rename hands the note to a new session, and
 * the views, with their undo history, stay. A body change moves `updatedAt`
 * when the document holds a valid one; it never adds the field.
 */
export function noteBody(
	current: () => RowSession<NoteFields>,
	now: () => NoteFields['updatedAt'] = instantNow,
): BodyDraft {
	return {
		get body() {
			return current().state.document.body;
		},
		input(body) {
			const session = current();
			return session.change({
				body,
				...(session.state.reading.fields.updatedAt !== undefined && {
					fields: { updatedAt: now() },
				}),
			});
		},
		refuse: (reason) => current().refuse(reason),
	};
}

/**
 * The values a new note gets, for each declared field this text has no valid
 * value for: a field that is absent, and a field whose value does not
 * conform. Undefined when every field is valid. Applying it is a repair a
 * person asks for; it replaces a nonconforming value.
 */
export function fieldDefaults(
	content: TableReading<NoteFields>,
	now: NoteFields['updatedAt'],
): Partial<NoteFields> | undefined {
	if (content.issues.length === 0) return undefined;
	const defaults: NoteFields = {
		folderId: null,
		title: '',
		pinned: false,
		createdAt: now,
		updatedAt: now,
		deletedAt: null,
	};
	const needed: Partial<NoteFields> = {};
	for (const [key, value] of Object.entries(defaults))
		if (!Object.hasOwn(content.fields, key))
			Object.assign(needed, { [key]: value });
	return Object.keys(needed).length === 0 ? undefined : needed;
}

/**
 * Set fields in a note file's text being repaired, leaving the body and
 * every other key as written.
 */
export function repairFields(
	source: string,
	fields: Partial<NoteFields>,
): Result<string, string> {
	const { data: patched, error: refusal } = patchRowText(source, { fields });
	if (refusal === null) return Ok(patched);

	return Err(
		refusal.kind === 'unparsed' ? refusal.error.message : refusal.reason,
	);
}

/** Plain text from the start of a Markdown body, for list previews. */
export function previewText(body: string | undefined, limit = 120): string {
	if (!body) return '';
	let text = '';
	for (const line of body.split(/\r?\n/)) {
		const plain = line
			.replace(
				/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/,
				'',
			)
			.replace(/[*_~`]/g, '')
			.trim();
		if (plain === '' || /^`{3}/.test(line.trim())) continue;
		text += text === '' ? plain : ` ${plain}`;
		if (text.length >= limit) break;
	}
	return text.slice(0, limit);
}

/** The name a person sees for a note: its title, else its first line of text. */
export function displayTitle(
	title: string | undefined,
	body: string | undefined,
): string {
	if (title !== undefined && title.trim() !== '') return title;
	return previewText(body, 60) || 'Untitled';
}
