/**
 * A note's text: its Markdown body for the rich-text view, the text a list
 * shows, and help for repairing a note's file as text.
 *
 * A structured note is its row editor's complete document: fields and a
 * Markdown body. The rich-text view and the Source view both edit that body
 * through `noteBody`; each edit gives the editor the whole document in its
 * canonical form. A note whose text does not read as one is repaired in its file view,
 * and `repairFields` is the one change made to that text here: a person asks
 * for it.
 */
import { patchRowText, type TableReading } from '@epicenter/folder';
import type { Node } from 'prosemirror-model';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { instantNow, type NoteFields } from './data.js';
import {
	type BodyInspection,
	checkNoteDoc,
	inspectNoteBody,
} from './editor/markdown.js';
import type { NoteSession } from './note-session.svelte.js';

export type RichAvailability =
	| {
			readonly editable: true;
			readonly inspection: Extract<BodyInspection, { supported: true }>;
	  }
	| { readonly editable: false; readonly reasons: readonly string[] };

/**
 * The last body asked about, and its answer. The view, its edits, and its
 * check of the body all ask about one body until it changes, and an answer
 * depends on nothing but the text.
 */
let decoded:
	| { readonly body: string; readonly availability: RichAvailability }
	| undefined;

/**
 * Whether this body can be edited as rich text, and why not when it cannot:
 * the editor must be able to write it back as the Markdown it read. The same
 * text gets the same answer, and is decoded once while it is the last asked.
 */
export function richAvailability(body: string): RichAvailability {
	if (decoded?.body === body) return decoded.availability;
	const inspection = inspectNoteBody(body);
	const availability: RichAvailability = inspection.supported
		? { editable: true, inspection }
		: { editable: false, reasons: inspection.reasons };
	decoded = { body, availability };
	return availability;
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
 * A note's body as its views read and write it: text for Source, a document
 * for rich text. Both read the note's current body and write the whole note.
 */
export type BodyDraft = {
	readonly body: string;
	/** Take the whole new body text. False means it was not taken. */
	input(body: string): boolean;
	/** The body as a rich-text document, or why it cannot be one. */
	readonly rich: RichAvailability;
	/**
	 * Take a document as the body, written as Markdown that opens as the same
	 * document. False means it was not taken.
	 */
	inputDoc(doc: Node): boolean;
};

/**
 * A note's body, as the rich-text and Source views edit it, in whichever
 * session holds the note now: a rename hands the note to a new session, and
 * the views, with their undo history, stay. `current` is read on every call,
 * never kept. `mounted` is the view's own lifetime: a control something
 * still holds can deliver input after its view is gone, and that input is
 * not taken. A body change moves `updatedAt`; it never adds the field.
 * `input` answers whether the editor took the body. A refused body changes
 * nothing; with `keep` (the Source view) it stays in that view with the
 * reason, since its control would otherwise show the saved body again.
 */
export function noteBody(
	current: () => NoteSession,
	{
		mounted = () => true,
		now = instantNow,
		keep = false,
	}: {
		mounted?: () => boolean;
		now?: () => NoteFields['updatedAt'];
		keep?: boolean;
	} = {},
): BodyDraft {
	function body() {
		const session = current();
		return session.row.status === 'valid' ? session.row.body : '';
	}
	function input(text: string) {
		if (!mounted()) return false;
		const session = current();
		return (
			session.edit(
				{
					body: text,
					fields:
						session.row.status === 'valid' &&
						session.row.fields.updatedAt !== undefined
							? { updatedAt: now() }
							: {},
				},
				{ keep },
			) === undefined
		);
	}
	return {
		get body() {
			return body();
		},
		input,
		get rich() {
			return richAvailability(body());
		},
		inputDoc(doc) {
			if (!mounted()) return false;
			const check = checkNoteDoc(doc);
			if (!check.ok) {
				current().refuse(check.reason);
				return false;
			}
			const previous = body();
			const next = bodyText(check.markdown, previous);
			// An edit Markdown has no spelling for (a new empty paragraph) leaves
			// the body as it is, so it does not make the note newer.
			return next === previous || input(next);
		},
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
