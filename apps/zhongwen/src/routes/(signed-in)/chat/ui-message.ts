/**
 * UIMessage boundary: persisted chat message to TanStack AI UIMessage.
 *
 * Single boundary where persisted JSON parts are cast to MessagePart[].
 * Safe because parts are always produced by TanStack AI; the drift check
 * below fails the build when a TanStack AI upgrade changes the part union.
 */

import type { ChatMessage } from '@epicenter/zhongwen';
import type { UIMessage } from '@tanstack/ai-client';
import type { JsonValue } from 'wellcrafted/json';

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

type _PartTypeDriftCheck = Expect<
	Equal<UiMessagePart['type'], ExpectedPartTypes>
>;

export function toUiMessage(message: ChatMessage): UIMessage {
	return {
		id: message.id,
		role: message.role,
		parts: message.parts as unknown as UiMessagePart[],
		createdAt: new Date(message.createdAt),
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
