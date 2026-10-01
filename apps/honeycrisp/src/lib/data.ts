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
import {
	type CreateRowOf,
	defineStore,
	defineTable,
	field,
} from '@epicenter/app';
import { InstantString } from '@epicenter/app/field';
import type { Entry } from '@epicenter/app/files';
import { APPS } from '@epicenter/constants/apps';

export const honeycrispDefinition = defineStore({
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
/** The stem of `folders/<id>.md`. */
export type FolderId = string;

export type NoteFields = CreateRowOf<typeof honeycrispDefinition.tables.notes>;
export type FolderFields = CreateRowOf<
	typeof honeycrispDefinition.tables.folders
>;

export type NoteEntry = Entry<NoteFields>;
export type FolderEntry = Entry<FolderFields>;

export const NOTES = 'notes';
export const FOLDERS = 'folders';

export function notePath(id: NoteId): string {
	return `${NOTES}/${id}.md`;
}

/** The note id of a row path, or undefined when the path is not a note row. */
export function noteIdOf(path: string): NoteId | undefined {
	const match = /^notes\/([^/]+)\.md$/.exec(path);
	return match?.[1];
}

/** The current time as the files store it. */
export const instantNow = (): InstantString => InstantString.now();
