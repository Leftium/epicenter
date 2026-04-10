/**
 * Workspace definition — branded IDs, table definitions, and workspace definition.
 *
 * Fuji is a personal CMS with a 1:1 mapping to your blog. Entries are content
 * pieces—articles, thoughts, ideas—organized by tags and type, displayed in a
 * data table with an editor panel. Each entry has a rich-text content document
 * for collaborative editing via ProseMirror + y-prosemirror.
 *
 * Contains the branded EntryId type, entries table definition with
 * DateTimeString timestamps, KV settings, and the workspace definition.
 */

import {
	DateTimeString,
	defineKv,
	defineTable,
	defineWorkspace,
	type InferTableRow,
} from '@epicenter/workspace';
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

// ─── Branded IDs ──────────────────────────────────────────────────────────────

/**
 * Branded entry ID — nanoid generated when an entry is created.
 *
 * Prevents accidental mixing with other string IDs at compile time.
 */
export type EntryId = string & Brand<'EntryId'>;
export const EntryId = type('string').pipe((s): EntryId => s as EntryId);

// ─── Tables ───────────────────────────────────────────────────────────────────

/**
 * Entries table — content pieces in a personal CMS.
 *
 * Each entry has a title, subtitle (editorial hook for blog listings and table
 * display), type classification, and freeform tags. Both `type` and `tags` are
 * always present—an unclassified entry has empty arrays, not missing fields.
 *
 * `date` is the user-defined date associated with the entry—the "when" of the
 * content itself. For a blog post it's the publish date, for a journal entry
 * it's when it happened, for research notes it's the reference date. Always
 * present—defaults to `createdAt` on creation, editable by the user afterward.
 *
 * Entries support pinning (pinned entries sort to the top of lists) and soft
 * deletion via `deletedAt`. Soft-deleted entries move to "Recently Deleted"
 * rather than being permanently destroyed—critical for CRDT conflict safety
 * when two devices diverge.
 *
 * The rich-text content document is attached via `.withDocument('content')` and
 * keyed by entry `id` for a 1:1 mapping. Edits to the document automatically
 * touch `updatedAt`.
 */
const entriesTable = defineTable(
	type({
		id: EntryId,
		title: 'string',
		subtitle: 'string',
		type: 'string[]',
		tags: 'string[]',
		pinned: 'boolean',
		'deletedAt?': DateTimeString.or('undefined'),
		date: DateTimeString,
		createdAt: DateTimeString,
		updatedAt: DateTimeString,
		_v: '1',
	}),
).withDocument('content', {
	guid: 'id',
	onUpdate: () => ({ updatedAt: DateTimeString.now() }),
});

export type Entry = InferTableRow<typeof entriesTable>;

// ─── Workspace ────────────────────────────────────────────────────────────────

export const fujiWorkspace = defineWorkspace({
	id: 'epicenter.fuji' as const,
	tables: { entries: entriesTable },
	kv: {
		selectedEntryId: defineKv(EntryId.or(type('null'))),
		viewMode: defineKv(type("'table' | 'timeline'")),
		sortBy: defineKv(type("'date' | 'updatedAt' | 'createdAt' | 'title'")),
	},
});
