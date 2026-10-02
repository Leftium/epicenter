/**
 * A note's source text, read and changed as one string.
 *
 * The draft a person edits is the whole file: frontmatter and body. The
 * rich-text view changes only the body and the Source view changes anything,
 * so both go through these functions and share one string. Every change is a
 * source-preserving patch: unknown frontmatter keys, comments, quoting, and
 * line endings are kept as written.
 *
 * Text is read with the notes table's own interpreter (`InspectNote`), the
 * one that reads saved files. A draft that does not parse has no body and no
 * fields here either, and is repaired in the Source view.
 */
import {
	type PatchRefusal,
	patchSource,
	type TableReading,
} from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderFields, InspectNote, NoteFields } from './data.js';
import { type BodyInspection, inspectNoteBody } from './editor/markdown.js';

export type RichAvailability =
	| {
			readonly editable: true;
			/** The body text the document was parsed from. */
			readonly body: string;
			readonly inspection: Extract<BodyInspection, { supported: true }>;
	  }
	| { readonly editable: false; readonly reasons: readonly string[] };

/**
 * Whether this source can be edited as rich text, and why not when it cannot.
 * It needs the source to parse and the body to be Markdown the editor can
 * write back. A field with an issue does not stand in the way of the body.
 */
export function richAvailability(
	source: string,
	inspect: InspectNote,
): RichAvailability {
	const { body, parseError } = inspect(source);
	if (body === undefined)
		return {
			editable: false,
			reasons: parseError?.diagnostics.map(
				(diagnostic) => diagnostic.message,
			) ?? ['This note has no text to edit.'],
		};
	const inspection = inspectNoteBody(body);
	if (!inspection.supported)
		return { editable: false, reasons: inspection.reasons };
	return { editable: true, body, inspection };
}

/**
 * The file body for serialized rich text: blank lines between the
 * frontmatter and the text are kept, the text ends with one line break, and
 * the file's CRLF line endings are kept when it uses them.
 */
export function bodyText(markdown: string, previousBody: string): string {
	const lead = /^(?:\r?\n)*/.exec(previousBody)?.[0] ?? '';
	const body = markdown === '' ? lead : `${lead}${markdown}\n`;
	return previousBody.includes('\r\n') ? body.replace(/\r?\n/g, '\r\n') : body;
}

/** A patch refusal in words: why the source did not parse, or why the change is not safe. */
function refusalMessage(refusal: PatchRefusal): string {
	return refusal.kind === 'unparsed' ? refusal.error.message : refusal.reason;
}

/**
 * Replace the body with serialized rich text. `updatedAt` moves only when
 * the file holds a valid one: a body edit neither adds the field nor
 * overwrites a value that needs repair.
 */
export function applyRichBody(
	source: string,
	markdown: string,
	now: NoteFields['updatedAt'],
	inspect: InspectNote,
): Result<string, string> {
	const read = inspect(source);
	if (read.body === undefined)
		return Err(read.parseError?.message ?? 'This note has no text to edit.');
	const patched = patchSource(source, {
		body: bodyText(markdown, read.body),
		...(read.fields.updatedAt !== undefined && {
			fields: { updatedAt: now },
		}),
	});
	return patched.error ? Err(refusalMessage(patched.error)) : Ok(patched.data);
}

/** Change frontmatter fields, leaving the body and every other key as written. */
export function applyFields(
	source: string,
	fields: Partial<NoteFields> | Partial<FolderFields>,
): Result<string, string> {
	const patched = patchSource(source, { fields });
	return patched.error ? Err(refusalMessage(patched.error)) : Ok(patched.data);
}

/** The source of a new note or folder file: both fences around its fields in order, and no body. */
export function newSource(
	fields: NoteFields | FolderFields,
): Result<string, string> {
	return applyFields('---\n---\n', fields);
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
