/**
 * UIMessage boundary: persisted chat rows on one side, TanStack AI types on the other.
 *
 * Opensidian stores chat messages in the workspace CRDT as JSON-compatible data,
 * but the chat UI and model adapters speak TanStack AI's `UIMessage` / `MessagePart`
 * types at runtime. Keeping the conversion in one file makes schema drift loud: if
 * either side changes shape, TypeScript fails here instead of letting the mismatch
 * leak through the app.
 */

import type { UIMessage } from '@tanstack/ai-svelte';
import type { JsonValue } from 'wellcrafted/json';

import type { ChatMessage, ChatMessageId } from 'opensidian';

type Expect<T extends true> = T;
type Equal<TLeft, TRight> =
	(<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
		? true
		: false;

// Derive the part type from UIMessage so the drift check and the cast guard
// the union the UI actually consumes (@tanstack/ai-client's MessagePart), not
// the structurally similar server union in @tanstack/ai.
type UiMessagePart = UIMessage['parts'][number];

type ExpectedPartTypes =
	| 'text'
	| 'image'
	| 'audio'
	| 'video'
	| 'document'
	| 'tool-call'
	| 'tool-result'
	| 'thinking'
	| 'structured-output';

type _ChatMessageIdDriftCheck = Expect<Equal<ChatMessage['id'], ChatMessageId>>;
type _PartTypeDriftCheck = Expect<
	Equal<UiMessagePart['type'], ExpectedPartTypes>
>;

/**
 * Convert one persisted workspace chat message into TanStack AI's runtime message.
 *
 * This is the single boundary where the JSON-backed `parts` array is retyped to
 * `MessagePart[]` for the UI layer.
 */
export function toUiMessage(msg: ChatMessage): UIMessage {
	return {
		id: msg.id,
		role: msg.role,
		parts: msg.parts as unknown as UiMessagePart[],
		createdAt: new Date(msg.createdAt),
	};
}

/**
 * Serialize live TanStack AI parts for the chatMessages table.
 *
 * The inverse of {@link toUiMessage}'s cast: parts are plain
 * structuredClone-compatible objects, so they store as-is. Routing writes
 * through here also checks the parts against the TanStack AI union at
 * compile time before they become untyped JSON.
 */
export function toPersistedParts(parts: UiMessagePart[]): JsonValue[] {
	return parts as unknown as JsonValue[];
}
