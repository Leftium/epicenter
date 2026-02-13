import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';
import type * as Y from 'yjs';
import { type Guid, generateGuid } from '@epicenter/hq';

/**
 * Timeline entry shapes — a discriminated union on 'type'.
 * These describe the SHAPE of what's stored. At runtime, entries are Y.Map
 * instances accessed via .get('type'), .get('content'), etc.
 */
export type TextEntry = { type: 'text'; content: Y.Text };
export type RichTextEntry = {
	type: 'richtext';
	content: Y.XmlFragment;
	frontmatter: Y.Map<unknown>;
};
export type BinaryEntry = { type: 'binary'; content: Uint8Array };
export type TimelineEntry = TextEntry | RichTextEntry | BinaryEntry;

/** Content modes supported by timeline entries */
export type ContentMode = TimelineEntry['type'];

import type { InferTableRow } from '@epicenter/hq/static';
import type { filesTable } from './file-table.js';

/** Branded file identifier — a Guid that is specifically a file ID */
export type FileId = Guid & Brand<'FileId'>;
export const FileId = type('string').pipe((s): FileId => s as FileId);

/** Generate a new unique file identifier */
export function generateFileId(): FileId {
	return generateGuid() as FileId;
}

/** File metadata row derived from the files table definition */
export type FileRow = InferTableRow<typeof filesTable>;

export type ContentDocStore = {
	/** Get or create a Y.Doc for a file. Awaits provider readiness (e.g. IndexedDB sync). Idempotent. */
	ensure(fileId: FileId): Promise<Y.Doc>;
	/** Destroy a specific file's Y.Doc and its providers. No-op if not created. */
	destroy(fileId: FileId): Promise<void>;
	/** Destroy all Y.Docs and their providers. Called on filesystem/workspace shutdown. */
	destroyAll(): Promise<void>;
};
