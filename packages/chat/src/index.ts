/**
 * Canonical chat-conversation storage, shared by every chat surface
 * (opensidian, vocab, local-books, tab-manager).
 *
 * A conversation is a row in the {@link conversationsTable}: light, synced
 * metadata (title, model, timestamps) that drives the conversation list. Its
 * turns are NOT rows: each row's `messages` handle opens a synced child doc, a
 * last-write-wins store of finished {@link AgentMessage} records keyed by id
 * (ADR-0046/0047). The open client runs the one agent loop and writes each
 * finished message into that doc; the live turn never enters the CRDT.
 *
 * This package is the one place allowed to know both the storage primitives
 * (`defineTable` + `attachKvStore`, from `@epicenter/workspace`) and the agent
 * domain (`AgentMessage`, from `@epicenter/workspace/agent`). The agent loop's
 * package stays storage-agnostic and the workspace package stays
 * domain-agnostic; the conversation storage that needs both lives here.
 */

import { field } from '@epicenter/field';
import {
	attachKvStore,
	defineTable,
	generateId,
	type Id,
	type InferTableRow,
} from '@epicenter/workspace';
import type { AgentMessage } from '@epicenter/workspace/agent';
import type { Brand } from 'wellcrafted/brand';

/** Branded conversation id: a nanoid minted when a conversation is created. */
export type ConversationId = Id & Brand<'ConversationId'>;

/** Mint a unique {@link ConversationId}. */
export const generateConversationId = (): ConversationId =>
	generateId<ConversationId>();

/**
 * Cast a stored key to a {@link ConversationId}. The constrained `string`
 * parameter is what earns it over a bare `as` at the call site.
 */
export const asConversationId = (value: string): ConversationId =>
	value as ConversationId;

/**
 * The conversations table: the synced chat list. One row per conversation,
 * carrying only the metadata the list needs; the turns live in the `messages`
 * child doc (keyed by message id). `model` is the conversation's model pick (an
 * app with a single fixed model writes it once and never reads it); the provider
 * is derived from it, so it is not stored separately.
 */
export const conversationsTable = defineTable({
	id: field.string<ConversationId>(),
	title: field.string(),
	model: field.string(),
	createdAt: field.instant(),
	updatedAt: field.instant(),
}).docs({ messages: (ydoc) => attachKvStore<AgentMessage>(ydoc) });

/** One conversation row. */
export type Conversation = InferTableRow<typeof conversationsTable>;
