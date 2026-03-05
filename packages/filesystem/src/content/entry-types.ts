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
