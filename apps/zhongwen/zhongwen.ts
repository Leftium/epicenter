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
 * per-conversation choice, so it is never stored on the conversation row. Both
 * answer paths read it: the browser sends it with the HTTP kickoff (the server
 * derives the provider from the catalog), and the always-on daemon actor builds
 * its Gemini adapter from it directly.
 */
export const ZHONGWEN_MODEL = 'gemini-3.5-flash' satisfies ServableModel;

/**
 * The bilingual system prompt every Zhongwen answer is generated under. An app
 * constant like {@link ZHONGWEN_MODEL}, shared by both answer paths so they
 * produce the same voice: the browser sends it with the HTTP kickoff, and the
 * always-on daemon actor passes it to its provider. It lives here, in the
 * isomorphic contract, rather than in a route folder so the node daemon can read
 * it without importing browser code.
 */
export const ZHONGWEN_SYSTEM_PROMPT = `You are a bilingual Chinese-English language assistant. Your responses mix English and Mandarin Chinese naturally.

Guidelines:
- Use English for explanations, transitions, and meta-commentary
- Use Mandarin Chinese (simplified characters only, 简体字) for vocabulary, example sentences, and conversational phrases
- Never include pinyin in your responses: the client adds it automatically above each character
- Never use traditional characters (繁體字)
- When teaching vocabulary, present the Chinese naturally inline: "The word 学习 means to study"
- For example sentences, write them in Chinese then explain in English
- Adjust difficulty based on context clues from the user's questions
- Be conversational and encouraging

Example response style:
"The phrase 你好 is the most common greeting. For something more casual with friends, you can say 嘿 or 哈喽. In a formal setting, try 您好. The 您 shows extra respect."`;

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
