/**
 * Opensidian workspace contract: id, branded types, tables, base actions, and
 * per-row child document models. Isomorphic: no IndexedDB, WebSockets, Svelte
 * state, browser shell APIs, or daemon process lifecycle.
 *
 * Distribution: `apps/opensidian/package.json` exports this file as the
 * `opensidian` package root. Browser code, daemon code, and tests all import
 * from here. The table shapes here are the wire contract for sync; forking a
 * column shape breaks sync compatibility with peers running the canonical
 * schema.
 *
 * Composition lives elsewhere:
 *  - `apps/opensidian/opensidian.browser.ts` -> `openOpensidianBrowser({ signedIn, nodeId })`
 *  - `apps/opensidian/mount.ts`                      -> `opensidian()` mount factory
 */

import { conversationsTable } from '@epicenter/chat';
import { field } from '@epicenter/field';
import { filesTable } from '@epicenter/filesystem';
import {
	defineActions,
	defineTable,
	defineWorkspace,
	type InferTableRow,
	type WorkspaceFromDefinition,
} from '@epicenter/workspace';

/**
 * Tool trust: per-tool approval preferences for chat actions.
 *
 * Tracks whether a tool should keep asking for approval or be auto-approved,
 * which lets Opensidian remember the user's trust decisions across sessions.
 *
 * Schema only today: no Opensidian surface reads or writes this table, and
 * the chat UI asks for approval on every call. Tab-manager's toolTrust state
 * (shouldAutoApprove plus an Always Allow action) is the reference shape if
 * Opensidian adopts auto-approval; until then the divergence is deliberate.
 */
const toolTrustTable = defineTable({
	id: field.string(),
	trust: field.select(['ask', 'always']),
});
export type ToolTrust = InferTableRow<typeof toolTrustTable>;

/**
 * Opensidian's shared workspace definition.
 *
 * Combines the filesystem-backed notes table with the chat tables so the app
 * can store notes, conversations, messages, and tool approvals in one schema.
 *
 * Runtime openers attach persistence, sync, browser services, materializers,
 * and UI state around this shared model.
 */
export const opensidianWorkspace = defineWorkspace({
	id: 'epicenter-opensidian',
	name: 'opensidian',
	tables: {
		files: filesTable,
		conversations: conversationsTable,
		toolTrust: toolTrustTable,
	},
	kv: {},
	actions: () => defineActions({}),
});
export type OpensidianWorkspace = WorkspaceFromDefinition<
	typeof opensidianWorkspace
>;
