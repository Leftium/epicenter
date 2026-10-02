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
	type FileTable,
	field,
	rowPath,
	rowStemOf,
	type TableSnapshot,
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

/**
 * A saved file as it was read. `fields` holds the declared fields that
 * validated, each by itself, and none when the text does not parse; `source`
 * is then all there is to show. A folder's id, the value a note's `folderId`
 * holds, is its literal `stem`.
 */
export type NoteEntry = TableSnapshot<NoteFields>;
export type FolderEntry = TableSnapshot<FolderFields>;

export const NOTES = 'notes';

export function notePath(id: NoteId): string {
	return rowPath(NOTES, id);
}

/**
 * The note id of a row path, or undefined when the path is not a note row.
 * The id is the literal stem, so it may be empty (`notes/.md`): compare it
 * with `undefined`, never by truthiness.
 */
export function noteIdOf(path: string): NoteId | undefined {
	return rowStemOf(NOTES, path);
}

/** How the notes table reads source text: `folder.tables.notes.inspect`. */
export type InspectNote = FileTable<NoteFields>['inspect'];

/** The name a person sees for a folder: its `name`, else its file. */
export function folderLabel(folder: FolderEntry): string {
	const { name } = folder.fields;
	if (name !== undefined && name !== '') return name;
	// An empty stem (`folders/.md`) is not a readable label.
	return folder.stem === '' ? folder.path : folder.stem;
}

/** Why a saved file needs repair, in the first message that says so, or undefined. */
export function repairReason(
	entry: TableSnapshot<unknown>,
): string | undefined {
	return entry.parseError?.message ?? entry.issues[0]?.message;
}

/** The current time as the files store it. */
export const instantNow = (): InstantString => InstantString.now();
