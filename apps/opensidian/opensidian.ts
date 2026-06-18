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

import { field } from '@epicenter/field';
import { filesTable } from '@epicenter/filesystem';
import {
	defineActions,
	defineTable,
	defineWorkspace,
	generateId,
	type Id,
	type InferTableRow,
	nullable,
	type WorkspaceFromDefinition,
} from '@epicenter/workspace';
import {
	attachChatBrowserAnswerer,
	attachChatTranscript,
	type ChatStream,
} from '@epicenter/workspace/ai';
import type * as Y from 'yjs';
import type { Brand } from 'wellcrafted/brand';

/**
 * Branded conversation ID for a single chat thread.
 *
 * Used as the primary key for conversations and as the foreign key for all
 * messages that belong to that thread. The brand prevents accidental mixing
 * with message IDs or other plain strings.
 */
export type ConversationId = Id & Brand<'ConversationId'>;

/**
 * Syntactic sugar for `value as ConversationId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as ConversationId` should appear.
 */
export const asConversationId = (value: string): ConversationId =>
	value as ConversationId;

/**
 * Generate a unique {@link ConversationId} for a new conversation row.
 *
 * This keeps call sites from casting raw strings and makes the ID source of
 * truth obvious wherever a conversation is created.
 */
export const generateConversationId = (): ConversationId =>
	generateId<ConversationId>();

/**
 * Branded chat message ID for one persisted assistant, user, or system message.
 *
 * The brand keeps message IDs distinct from conversation IDs so references
 * stay type-safe across joins and edits.
 */
export type ChatMessageId = Id & Brand<'ChatMessageId'>;

/**
 * Syntactic sugar for `value as ChatMessageId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as ChatMessageId` should appear.
 */
export const asChatMessageId = (value: string): ChatMessageId =>
	value as ChatMessageId;

/**
 * Generate a unique {@link ChatMessageId} for a new chat message.
 *
 * This mirrors {@link generateConversationId} and centralizes the branded ID
 * cast in one place.
 */
export const generateChatMessageId = (): ChatMessageId =>
	generateId<ChatMessageId>();

/**
 * The conversation transcript child doc plus the browser in-process answerer.
 *
 * Each conversation owns one synced transcript doc (the doc-as-wire body,
 * ADR-0020/0021): the user turn and the streamed assistant parts live here, and
 * the UI renders from it. `answer(startStream)` runs the in-process answerer
 * (ADR-0021's `in-process` trigger) that claims the unanswered turn and streams
 * the reply into this same doc, sharing the daemon's claim predicate
 * (`findUnansweredTurn`). Opensidian has no cloud agent and no daemon hosting
 * these conversations, so the browser is the sole answerer: no double-answer.
 */
function attachOpensidianTranscript(doc: Y.Doc) {
	return {
		...attachChatTranscript(doc),
		/** Run the in-process answerer over this transcript; returns a stop fn. */
		answer(startStream: ChatStream): () => void {
			return attachChatBrowserAnswerer({ doc, startStream });
		},
	};
}

/**
 * Conversations: metadata for each chat thread.
 *
 * Stores the thread title, optional parent/subpage relationship, source
 * message linkage, and the chosen model. The provider is derived from the
 * model by the catalog, so it is not stored. The turns themselves are not rows:
 * each conversation's `messages` handle opens its synced transcript child doc.
 */
const conversationsTable = defineTable({
	id: field.string<ConversationId>(),
	title: field.string(),
	parentId: nullable(field.string<ConversationId>()),
	sourceMessageId: nullable(field.string<ChatMessageId>()),
	systemPrompt: nullable(field.string()),
	model: field.string(),
	createdAt: field.instant(),
	updatedAt: field.instant(),
}).docs({ messages: attachOpensidianTranscript });
export type Conversation = InferTableRow<typeof conversationsTable>;

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
