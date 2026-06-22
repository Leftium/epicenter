/**
 * Vocab workspace contract: id, branded types, tables, kv, and the workspace
 * factory. Isomorphic: no IndexedDB, WebSockets, Svelte state, or browser APIs.
 *
 * Distribution: this file is the `@epicenter/vocab` package root file
 * (the target of the package's `"."` export). The browser entrypoint imports the
 * schema from here and composes runtime-specific attachments around it. The table
 * and KV shapes here are the wire contract for sync; forking a column shape
 * breaks sync compatibility with peers running the canonical schema.
 *
 * Composition lives elsewhere:
 *  - `apps/vocab/vocab.browser.ts`
 *      → `openVocabBrowser({ signedIn, nodeId })`
 */

import { conversationsTable } from '@epicenter/chat';
import type { ServableModel } from '@epicenter/constants/ai-providers';
import {
	defineKv,
	defineWorkspace,
	generateId,
	type Id,
} from '@epicenter/workspace';
import type { AgentMessage } from '@epicenter/workspace/agent';
import { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';

// ─────────────────────────────────────────────────────────────────────────────
// Branded ID Types
// ─────────────────────────────────────────────────────────────────────────────

export type MessageId = Id & Brand<'MessageId'>;
export const generateMessageId = (): MessageId => generateId<MessageId>();

/**
 * Vocab runs a single Chinese-tuned model. It is an app constant, not a
 * per-conversation choice; the canonical conversations table requires a `model`,
 * so Vocab writes this constant on every row and never offers a per-conversation
 * pick. The client also reads it when it answers over the OpenAI-compatible
 * stream.
 */
export const VOCAB_MODEL = 'gemini-3.5-flash' satisfies ServableModel;

/**
 * The bilingual system prompt every Vocab answer is generated under. An app
 * constant like {@link VOCAB_MODEL}: the client passes it to the Epicenter
 * provider when it answers. It lives in this dep-free contract so the prompt is
 * single-homed, read by whichever module builds the stream.
 */
export const VOCAB_SYSTEM_PROMPT = `You are a bilingual Chinese-English language assistant. Your responses mix English and Mandarin Chinese naturally.

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
// Message Model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A complete chat message: the unit Vocab persists. Each finished message is
 * written once, whole, as one JSON blob in the conversation's LWW store keyed by
 * {@link MessageId} (ADR-0046/0047), the moment a turn finishes.
 *
 * It is the shared {@link AgentMessage} so Vocab rides the one client agent loop
 * (`@epicenter/workspace/agent`). Vocab is capability-free, so every message is
 * a single text part, but the parts-array shape is the same one a tool agent
 * fills with tool-call and tool-result parts.
 */
export type VocabMessage = AgentMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The isomorphic Vocab workspace definition.
 *
 * Conversation transcripts are not rows: each `conversations.messages` handle
 * opens a synced child doc derived from the conversation id, holding one
 * {@link VocabMessage} per key (ADR-0046). The open client tab answers
 * in-process (ADR-0043): it streams the live turn in component state and writes
 * each finished message into this store.
 */
export const vocabWorkspace = defineWorkspace({
	id: 'epicenter-vocab',
	name: 'vocab',
	tables: {
		conversations: conversationsTable,
	},
	kv: {
		showPinyin: defineKv(Type.Boolean(), () => true),
	},
});
