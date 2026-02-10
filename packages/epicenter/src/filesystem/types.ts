import type * as Y from 'yjs';

/** Sentinel ID for the virtual root directory (not stored in files table) */
export const ROOT_ID = '__ROOT__';

/** File metadata row stored in the files table (YKeyValueLww) */
export type FileRow = {
	id: string;
	name: string;
	parentId: string | null;
	type: 'file' | 'folder';
	size: number;
	createdAt: number;
	updatedAt: number;
	trashedAt: number | null;
};

/** Runtime indexes for O(1) path lookups (ephemeral, not stored in Yjs) */
export type FileSystemIndex = {
	/** "/docs/api.md" → "abc-123" */
	pathToId: Map<string, string>;
	/** "abc-123" → "/docs/api.md" */
	idToPath: Map<string, string>;
	/** parentId → [childId, ...] */
	childrenOf: Map<string, string[]>;
	/** fileId → content string (lazy cache) */
	plaintext: Map<string, string>;
};

export type TextDocumentHandle = {
	type: 'text';
	fileId: string;
	ydoc: Y.Doc;
	content: Y.Text;
};

export type RichTextDocumentHandle = {
	type: 'richtext';
	fileId: string;
	ydoc: Y.Doc;
	content: Y.XmlFragment;
	frontmatter: Y.Map<unknown>;
};

export type DocumentHandle = TextDocumentHandle | RichTextDocumentHandle;

export type ContentDocPool = {
	/** Get or create a content doc. Increments refcount. */
	acquire(fileId: string, fileName: string): DocumentHandle;
	/** Decrement refcount. Doc destroyed when refcount hits 0. */
	release(fileId: string): void;
	/** Get without incrementing refcount. Returns undefined if not loaded. */
	peek(fileId: string): DocumentHandle | undefined;
	/** Load a doc, read plaintext, release immediately. For grep/search. */
	loadAndCache(fileId: string, fileName: string): string;
};
