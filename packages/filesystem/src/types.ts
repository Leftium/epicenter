import { type Guid, generateGuid, generateId, type Id } from '@epicenter/hq';
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';
import type * as Y from 'yjs';

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
export type SheetEntry = {
	type: 'sheet';
	columns: Y.Map<Y.Map<string>>;
	rows: Y.Map<Y.Map<string>>;
};
export type TimelineEntry =
	| TextEntry
	| RichTextEntry
	| BinaryEntry
	| SheetEntry;

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

/** Branded row identifier — a 10-char nanoid that is specifically a row ID */
export type RowId = Id & Brand<'RowId'>;

/** Generate a new unique row identifier */
export function generateRowId(): RowId {
	return generateId() as RowId;
}

/** Branded column identifier — a 10-char nanoid that is specifically a column ID */
export type ColumnId = Id & Brand<'ColumnId'>;

/** Generate a new unique column identifier */
export function generateColumnId(): ColumnId {
	return generateId() as ColumnId;
}

/**
 * Column definition stored in a column Y.Map.
 *
 * This type documents the expected shape but cannot be enforced at runtime
 * since Y.Maps are dynamic key-value stores. Use defensive reading with
 * defaults when accessing column properties.
 */
export type ColumnDefinition = {
	/** Display name of the column */
	name: string;
	/** Column kind determines cell value interpretation */
	kind: 'text' | 'number' | 'date' | 'select' | 'boolean';
	/** Display width in pixels (stored as string) */
	width: string;
	/** Fractional index for column ordering */
	order: string;
};
/** File metadata row derived from the files table definition */
export type FileRow = InferTableRow<typeof filesTable>;
