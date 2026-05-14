/**
 * Zhongwen workspace: schema definition with branded IDs and table/kv defs.
 *
 * Browser-agnostic: no IndexedDB, no Svelte imports, no Y.Doc construction.
 * The Y.Doc and attachments live in `blocks/script.ts` (Bun) and `browser.ts`
 * (env-bound), composed through `openZhongwenBrowser`.
 *
 * Distribution: this file is both the `@epicenter/zhongwen` npm root export
 * AND the `epicenter/zhongwen/workspace` jsrepo block. The table and KV
 * shapes here are the wire contract for sync: forking a column shape breaks
 * sync compatibility with peers running the canonical schema. Recipes
 * (script.ts, daemon-route.ts) are yours to edit freely. See apps/README.md
 * for the dual-channel convention.
 */

import {
	defineKv,
	defineTable,
	generateId,
	type Id,
	type InferTableRow,
} from '@epicenter/workspace';
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';

export const ZHONGWEN_WORKSPACE_ID = 'epicenter.zhongwen';

// ─────────────────────────────────────────────────────────────────────────────
// Branded ID Types
// ─────────────────────────────────────────────────────────────────────────────

export type ConversationId = Id & Brand<'ConversationId'>;
export const ConversationId = type('string').as<ConversationId>();
export const generateConversationId = (): ConversationId =>
	generateId() as ConversationId;

export type ChatMessageId = Id & Brand<'ChatMessageId'>;
export const ChatMessageId = type('string').as<ChatMessageId>();
export const generateChatMessageId = (): ChatMessageId =>
	generateId() as ChatMessageId;

// ─────────────────────────────────────────────────────────────────────────────
// Table Definitions
// ─────────────────────────────────────────────────────────────────────────────

const conversationsTable = defineTable(
	type({
		id: ConversationId,
		title: 'string',
		provider: 'string',
		model: 'string',
		createdAt: 'number',
		updatedAt: 'number',
		_v: '1',
	}),
);
export type Conversation = InferTableRow<typeof conversationsTable>;

const chatMessagesTable = defineTable(
	type({
		id: ChatMessageId,
		conversationId: ConversationId,
		role: "'user' | 'assistant'",
		parts: type({} as type.cast<JsonValue[]>),
		createdAt: 'number',
		_v: '1',
	}),
);
export type ChatMessage = InferTableRow<typeof chatMessagesTable>;

// ─────────────────────────────────────────────────────────────────────────────
// Schema Records
// ─────────────────────────────────────────────────────────────────────────────

export const zhongwenTables = {
	conversations: conversationsTable,
	chatMessages: chatMessagesTable,
};

export const zhongwenKv = {
	showPinyin: defineKv(type('boolean'), true),
};
