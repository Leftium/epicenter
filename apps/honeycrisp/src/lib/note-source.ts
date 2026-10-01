/**
 * A note's source text, read and changed without a schema of its own.
 *
 * The draft a person edits is the whole file: frontmatter and body. The
 * rich-text view changes only the body and the Source view changes anything,
 * so both go through these functions and share one string. Every change is a
 * source-preserving patch: unknown frontmatter keys, comments, quoting, and
 * line endings are kept as written.
 */
import { patchSource, readSource } from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderFields, NoteFields } from './data.js';
import { type BodyInspection, inspectNoteBody } from './editor/markdown.js';

export type RichAvailability =
	| {
			readonly editable: true;
			/** The body text the document was parsed from. */
			readonly body: string;
			readonly inspection: Extract<BodyInspection, { supported: true }>;
	  }
	| { readonly editable: false; readonly reasons: readonly string[] };

/** Whether this source can be edited as rich text, and why not when it cannot. */
export function richAvailability(source: string): RichAvailability {
	const read = readSource(source);
	if (read.body === undefined || read.values === undefined)
		return {
			editable: false,
			reasons: read.issues.map((issue) => issue.message),
		};
	const inspection = inspectNoteBody(read.body);
	if (!inspection.supported)
		return { editable: false, reasons: inspection.reasons };
	return { editable: true, body: read.body, inspection };
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

/**
 * Replace the body with serialized rich text. `updatedAt` moves only when
 * the file already has one, so a plain Markdown file gains no frontmatter.
 */
export function applyRichBody(
	source: string,
	markdown: string,
	now: NoteFields['updatedAt'],
): Result<string, string> {
	const read = readSource(source);
	if (read.body === undefined || read.values === undefined)
		return Err(
			read.issues[0]?.message ?? 'The frontmatter cannot be read safely',
		);
	const patched = patchSource(source, {
		body: bodyText(markdown, read.body),
		...(Object.hasOwn(read.values, 'updatedAt') && {
			fields: { updatedAt: now },
		}),
	});
	return patched.error ? Err(patched.error.reason) : Ok(patched.data);
}

/** Change frontmatter fields, leaving the body and every other key as written. */
export function applyFields(
	source: string,
	fields: Partial<NoteFields> | Partial<FolderFields>,
): Result<string, string> {
	const patched = patchSource(source, { fields });
	return patched.error ? Err(patched.error.reason) : Ok(patched.data);
}

/** The source of a new note or folder file: its fields in order, and no body. */
export function newSource(
	fields: NoteFields | FolderFields,
): Result<string, string> {
	return applyFields('', fields);
}

/** The declared fields a file lacks, filled with the values a new note gets. */
export function missingFields(
	source: string,
	now: NoteFields['updatedAt'],
): Partial<NoteFields> | undefined {
	const values = readSource(source).values;
	if (values === undefined) return undefined;
	const defaults: NoteFields = {
		folderId: null,
		title: '',
		pinned: false,
		createdAt: now,
		updatedAt: now,
		deletedAt: null,
	};
	const missing: Partial<NoteFields> = {};
	for (const [key, value] of Object.entries(defaults))
		if (!Object.hasOwn(values, key)) Object.assign(missing, { [key]: value });
	return Object.keys(missing).length === 0 ? undefined : missing;
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
export function displayTitle(title: unknown, body: string | undefined): string {
	if (typeof title === 'string' && title.trim() !== '') return title;
	return previewText(body, 60) || 'Untitled';
}
