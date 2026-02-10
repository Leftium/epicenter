import type * as Y from 'yjs';
import type { Brand } from 'wellcrafted/brand';
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
	/** FileId → "/docs/api.md" */
	idToPath: Map<FileId, string>;
	/** parentId (null = root) → [childId, ...] */
	childrenOf: Map<FileId | null, FileId[]>;
	/** fileId → content string (lazy cache) */
	plaintext: Map<FileId, string>;
};

export type TextDocumentHandle = {
	type: 'text';
	fileId: FileId;
	ydoc: Y.Doc;
	content: Y.Text;
};

export type RichTextDocumentHandle = {
	type: 'richtext';
	fileId: FileId;
	ydoc: Y.Doc;
	content: Y.XmlFragment;
	frontmatter: Y.Map<unknown>;
};

export type DocumentHandle = TextDocumentHandle | RichTextDocumentHandle;

export type ContentDocPool = {
	/** Get or create a content doc. Increments refcount. */
	acquire(fileId: FileId, fileName: string): DocumentHandle;
	/** Decrement refcount. Doc destroyed when refcount hits 0. */
	release(fileId: FileId): void;
	/** Get without incrementing refcount. Returns undefined if not loaded. */
	peek(fileId: FileId): DocumentHandle | undefined;
	/** Load a doc, read plaintext, release immediately. For grep/search. */
	loadAndCache(fileId: FileId, fileName: string): string;
};
