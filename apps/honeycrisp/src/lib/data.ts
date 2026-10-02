/**
 * Honeycrisp's inert declaration: two Markdown tables in one folder.
 *
 * A note is `notes/<id>.md` and a folder is `folders/<id>.md`. The file stem
 * is the identity; everything a person can change is frontmatter or body.
 * Folder membership is the note's `folderId`, so moving a note between
 * folders never moves its file.
 *
 * The body is plain Markdown text. The rich-text editor reads and writes it
 * through `editor/markdown.ts`; no codec is declared here.
 */
import { APPS } from '@epicenter/constants/apps';
import { InstantString } from '@epicenter/definition';
import {
	type CreateRowOf,
	defineFolder,
	defineTable,
	type Entry,
	field,
	rowPath,
	rowStemOf,
} from '@epicenter/folder';

export const honeycrispDefinition = defineFolder({
	id: APPS.HONEYCRISP.id,
	title: 'Honeycrisp',
	kv: {},
	tables: {
		folders: defineTable({
			fields: {
				name: field.string(),
				// Nullable rather than optional: a file field is one type, and
				// "absent" is reported as a missing field instead.
				icon: field.nullable(field.string()),
			},
		}),
		notes: defineTable({
			fields: {
				folderId: field.nullable(field.string()),
				title: field.string(),
				pinned: field.boolean(),
				createdAt: field.instant(),
				updatedAt: field.instant(),
				deletedAt: field.nullable(field.instant()),
			},
		}),
	},
});

/** The stem of `notes/<id>.md`. */
export type NoteId = string;

export type NoteFields = CreateRowOf<typeof honeycrispDefinition.tables.notes>;
export type FolderFields = CreateRowOf<
	typeof honeycrispDefinition.tables.folders
>;

export type NoteEntry = Entry<NoteFields>;
export type FolderEntry = Entry<FolderFields>;

export const NOTES = 'notes';

export function notePath(id: NoteId): string {
	return rowPath(NOTES, id);
}

/**
 * The note id of a row path, or undefined when the path is not a note row.
 * An id is never empty: `notes/.md` is a file the table lists, not a note
 * this app opens as one.
 */
export function noteIdOf(path: string): NoteId | undefined {
	const id = rowStemOf(NOTES, path);
	return id === '' ? undefined : id;
}

/**
 * The ID this app assigns to a note's `folderId` to name this folder: its
 * file stem, or `null` when the folder's filename has an issue. Such a folder
 * still has its literal stem for reading and display; the app does not hand
 * that stem out as a reference until the file is renamed.
 */
export function folderIdOf(folder: FolderEntry): string | null {
	return folder.issues?.some((issue) => issue.kind === 'filename')
		? null
		: folder.stem;
}

/** The current time as the files store it. */
export const instantNow = (): InstantString => InstantString.now();
