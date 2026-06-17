import { field } from '@epicenter/field';
import {
	attachTimeline,
	defineTable,
	type InferTableRow,
	nullable,
} from '@epicenter/workspace';
import type { FileId } from './ids.js';

export const filesTable = defineTable({
	id: field.string<FileId>(),
	name: field.string(),
	parentId: nullable(field.string<FileId>()),
	type: field.select(['file', 'folder']),
	size: field.number(),
	// Timestamps are canonical UTC instants, not raw millis: a fixed-width
	// instant sorts chronologically as TEXT (the SQLite mirror and the
	// recency index both rely on this) and stays readable in the CRDT.
	createdAt: field.instant(),
	updatedAt: field.instant(),
	trashedAt: nullable(field.instant()),
}).docs({
	content: {
		layout: attachTimeline,
		// Body edits bypass the tree API, so bump `updatedAt` here to keep the
		// same modification-time invariant the file operations already maintain.
		touch: 'updatedAt',
	},
});

/** File metadata row derived from the files table definition */
export type FileRow = InferTableRow<typeof filesTable>;

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
