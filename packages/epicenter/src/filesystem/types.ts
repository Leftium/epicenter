import type { Brand } from 'wellcrafted/brand';
import type * as Y from 'yjs';
import { type Guid, generateGuid } from '../dynamic/schema/fields/id.js';

/** Branded file identifier — a Guid that is specifically a file ID */
export type FileId = Guid & Brand<'FileId'>;

/** Generate a new unique file identifier */
export function generateFileId(): FileId {
	return generateGuid() as FileId;
}

/** File metadata row stored in the files table (YKeyValueLww) */
export type FileRow = {
	id: FileId;
	name: string;
	parentId: FileId | null;
	type: 'file' | 'folder';
	size: number;
	createdAt: number;
	updatedAt: number;
	trashedAt: number | null;
};

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
