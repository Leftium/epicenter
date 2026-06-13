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
 *      → `openZhongwenBrowser({ signedIn, deviceId })`
 *  - `apps/zhongwen/project.ts` → `zhongwen()` mount factory
 */

import { field } from '@epicenter/field';
import {
	createWorkspace,
	defineActions,
	defineKv,
	defineTable,
	defineWorkspace,
	docGuid,
	generateId,
	type Id,
	type InferTableRow,
	type Keyring,
} from '@epicenter/workspace';
import { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';

export const ZHONGWEN_ID = 'epicenter-zhongwen';

// ─────────────────────────────────────────────────────────────────────────────
// Branded ID Types
// ─────────────────────────────────────────────────────────────────────────────

export type ConversationId = Id & Brand<'ConversationId'>;
export const generateConversationId = (): ConversationId =>
	generateId<ConversationId>();
/**
 * Syntactic sugar for `value as ConversationId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as ConversationId` should appear.
 */
export const asConversationId = (value: string): ConversationId =>
	value as ConversationId;

// ─────────────────────────────────────────────────────────────────────────────
// Table Definitions
// ─────────────────────────────────────────────────────────────────────────────

const conversationsTable = defineTable({
	id: field.string<ConversationId>(),
	title: field.string(),
	provider: field.string(),
	model: field.string(),
	createdAt: field.number(),
	updatedAt: field.number(),
});
export type Conversation = InferTableRow<typeof conversationsTable>;

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Factory
// ─────────────────────────────────────────────────────────────────────────────

// Conversation transcripts are not a table: each lives in its own synced
// child doc (see `zhongwenConversationDocGuid` and `@epicenter/workspace/ai`),
// streamed into by the server generation actor. The conversations table is
// only the cheap list.
export function createZhongwen(opts: { keyring: () => Keyring }) {
	const workspace = createWorkspace({
		id: ZHONGWEN_ID,
		keyring: opts.keyring,
		tables: {
			conversations: conversationsTable,
		},
		kv: {
			showPinyin: defineKv(Type.Boolean(), () => true),
		},
	});

	return defineWorkspace({
		...workspace,
		actions: defineActions({}),
		[Symbol.dispose]() {
			workspace[Symbol.dispose]();
		},
	});
}
export type ZhongwenWorkspace = ReturnType<typeof createZhongwen>;

/**
 * Deterministic guid of a conversation's transcript sub-doc.
 *
 * Browser chat UIs (which open and sync the doc) and the server generation
 * actor (which receives this guid in the kickoff body) both name the same
 * Y.Doc through this composition. The transcript layout inside the doc is
 * owned by `@epicenter/workspace/ai` (`chat-doc.ts`).
 */
export const zhongwenConversationDocGuid = (conversationId: ConversationId) =>
	docGuid({
		workspaceId: ZHONGWEN_ID,
		collection: 'conversations',
		rowId: conversationId,
		field: 'messages',
	});
