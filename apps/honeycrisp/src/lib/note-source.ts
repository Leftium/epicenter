/**
 * A note's text: the body its rich-text and Source views write, the text a
 * list shows, and help for repairing a note's file as text.
 *
 * A structured note is its editor's complete document: fields and a Markdown
 * body. The rich-text view and the Source view both replace that body in the
 * whole document through `withBody`. A note whose text does not read as one is
 * repaired in its file view, and `repairFields` is the one change made to that
 * text here: a person asks for it.
 */
import {
	type CanonicalDocument,
	patchRowText,
	type TableReading,
} from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { instantNow, type NoteFields } from './data.js';

/**
 * The complete note with `body` as its body, every field kept. A body that
 * changes moves an existing `updatedAt` to `now` and never adds the field.
 * The same body gives back `note` itself: nothing about the note changed.
 */
export function withBody(
	note: CanonicalDocument,
	body: string,
	now: NoteFields['updatedAt'] = instantNow(),
): CanonicalDocument {
	if (body === note.body) return note;
	return {
		fields:
			note.fields.updatedAt === undefined
				? note.fields
				: { ...note.fields, updatedAt: now },
		body,
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
