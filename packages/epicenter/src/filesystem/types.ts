import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';
import type * as Y from 'yjs';
import { type Guid, generateGuid } from '../dynamic/schema/fields/id.js';
import type { InferTableRow } from '../static/types.js';
import type { filesTable } from './file-table.js';

/** Branded file identifier — a Guid that is specifically a file ID */
export type FileId = Guid & Brand<'FileId'>;
export const fileIdSchema = type('string').pipe((s): FileId => s as FileId);

/** Generate a new unique file identifier */
export function generateFileId(): FileId {
	return generateGuid() as FileId;
}

/** File metadata row derived from the files table definition */
export type FileRow = InferTableRow<typeof filesTable>;

/** Runtime indexes for O(1) path lookups (ephemeral, not stored in Yjs) */
export type FileSystemIndex = {
	/** "/docs/api.md" → FileId */
	pathToId: Map<string, FileId>;
	/** parentId (null = root) → [childId, ...] */
	childrenOf: Map<FileId | null, FileId[]>;
};

export type ContentDocStore = {
	/** Get or create a Y.Doc for a file. Idempotent — returns existing if already created. */
	ensure(fileId: FileId): Y.Doc;
	/** Destroy a specific file's Y.Doc. Called when a file is deleted. No-op if not created. */
	destroy(fileId: FileId): void;
	/** Destroy all Y.Docs. Called on filesystem/workspace shutdown. */
	destroyAll(): void;
};
