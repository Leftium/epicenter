/**
 * Workspace — schema and client for Fuji quick-capture notes.
 *
 * Fuji is a minimal, timeline-first note app with zero folders. Entries flow
 * in a timeline sorted by date. Each entry has a Y.Text body for collaborative
 * rich-text editing via Tiptap + y-prosemirror.
 *
 * Contains the branded EntryId type, entries table definition with DateTimeString
 * timestamps, KV settings, and the workspace client with IndexedDB persistence.
 */

import {
	createWorkspace,
	DateTimeString,
	dateTimeStringNow,
	defineKv,
	defineTable,
	defineWorkspace,
	type InferTableRow,
} from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
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
 * Entries table — temporal captures in a timeline.
 *
 * Unlike "notes" in Granny Smith or Honeycrisp, entries are temporal — they
 * flow in a timeline with no folder organisation. The `title` field is
 * auto-populated from the first line of content; `preview` holds the first
 * ~100 characters for the timeline list view.
 *
 * Each entry has a Y.Text document (`body`) for collaborative rich-text editing.
 * The document GUID matches the entry `id` so there's a 1:1 mapping.
 */
const entriesTable = defineTable(
	type({
		id: EntryId,
		title: 'string',
		preview: 'string',
		pinned: 'boolean',
		createdAt: DateTimeString,
		updatedAt: DateTimeString,
		_v: '1',
	}),
).withDocument('body', {
	guid: 'id',
	onUpdate: () => ({ updatedAt: dateTimeStringNow() }),
});

export type Entry = InferTableRow<typeof entriesTable>;

// ─── Workspace ────────────────────────────────────────────────────────────────

export const fujiWorkspace = defineWorkspace({
	id: 'epicenter.fuji' as const,
	tables: { entries: entriesTable },
	kv: {
		selectedEntryId: defineKv(EntryId.or(type('null'))),
		sortBy: defineKv(type("'dateEdited' | 'dateCreated'")),
	},
});

/**
 * Fuji workspace client — single Y.Doc instance with IndexedDB persistence.
 *
 * Access tables via `workspaceClient.tables.entries` and KV settings via
 * `workspaceClient.kv`. The client is ready when `workspaceClient.whenReady`
 * resolves.
 */
export default createWorkspace(fujiWorkspace).withExtension(
	'persistence',
	indexeddbPersistence,
);
