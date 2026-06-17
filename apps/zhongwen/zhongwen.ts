/**
 * Zhongwen workspace contract: id, branded types, tables, kv, actions, and
 * the workspace factory. Isomorphic: no IndexedDB, WebSockets, Svelte state,
 * browser APIs, or daemon process lifecycle.
 *
 * Distribution: this file is the `@epicenter/zhongwen` package root file
 * (the target of the package's `"."` export). Browser and daemon entrypoints
 * import the schema from here and compose runtime-specific attachments
 * around it. The table and KV shapes here are the wire contract for sync;
 * forking a column shape breaks sync compatibility with peers running the
 * canonical schema.
 *
 * Composition lives elsewhere:
 *  - `apps/zhongwen/zhongwen.browser.ts`
 *      → `openZhongwenBrowser({ signedIn, nodeId })`
 *  - `apps/zhongwen/mount.ts` → `zhongwen()` mount factory
 */

import type { ServableModel } from '@epicenter/constants/ai-providers';
import { field } from '@epicenter/field';
import {
	defineKv,
	defineTable,
	defineWorkspace,
	generateId,
	type Id,
	type InferTableRow,
	type NodeId,
	nullable,
} from '@epicenter/workspace';
import { attachChatTranscript } from '@epicenter/workspace/ai';
import { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';

// ─────────────────────────────────────────────────────────────────────────────
// Branded ID Types
// ─────────────────────────────────────────────────────────────────────────────

export type ConversationId = Id & Brand<'ConversationId'>;
export const generateConversationId = (): ConversationId =>
	generateId<ConversationId>();

/**
 * Zhongwen runs a single Chinese-tuned model. It is an app constant, not a
 * per-conversation choice, so it is never stored on the conversation row; the
 * send path passes it to the server, which derives the provider from the
 * catalog.
 */
export const ZHONGWEN_MODEL = 'gemini-3.5-flash' satisfies ServableModel;

// ─────────────────────────────────────────────────────────────────────────────
// Table Definitions
// ─────────────────────────────────────────────────────────────────────────────

const conversationsTable = defineTable({
	id: field.string<ConversationId>(),
	title: field.string(),
	createdAt: field.instant(),
	updatedAt: field.instant(),
	/**
	 * The node designated to answer this conversation, or `null` for the
	 * cloud-default path (ADR-0013). When set to a daemon's node id, that
	 * always-on actor claims and streams the reply and the browser skips its HTTP
	 * kickoff; `null` leaves the turn to the cloud HTTP generation path. Single
	 * field, two lifecycles, no double-answer.
	 */
	actorNodeId: nullable(field.string<NodeId>()),
}).docs({ messages: attachChatTranscript });
export type Conversation = InferTableRow<typeof conversationsTable>;

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The isomorphic Zhongwen workspace definition.
 *
 * Conversation transcripts are not rows: each `conversations.messages` handle
 * opens a synced child doc derived from the conversation id and streamed into
 * by the server generation actor.
 */
export const zhongwenWorkspace = defineWorkspace({
	id: 'epicenter-zhongwen',
	name: 'zhongwen',
	tables: {
		conversations: conversationsTable,
	},
	kv: {
		showPinyin: defineKv(Type.Boolean(), () => true),
	},
});
