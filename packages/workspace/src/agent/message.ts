/**
 * The persisted unit of an agent conversation: one finished message, written
 * whole as a last-write-wins JSON blob keyed by id (ADR-0046/0047). The live
 * turn streams in client state and never enters the doc; only a finished
 * message lands in the store.
 *
 * A message body is an ordered parts array: a capability-free agent (Vocab)
 * produces a single text part, and a tool agent interleaves tool-call and
 * tool-result parts. The shapes mirror TanStack AI's message parts but stay a
 * plain, JSON-stable record (no streaming state, no Yjs), so a finished message
 * round-trips through the LWW store unchanged.
 */
import type { ModelMessage, ToolCall } from '@tanstack/ai';
import type { JsonValue } from 'wellcrafted/json';

/** A run of prose. */
export type AgentTextPart = { type: 'text'; text: string };

/** A tool the model asked to run, with its parsed input. */
export type AgentToolCallPart = {
	type: 'tool-call';
	toolCallId: string;
	toolName: string;
	input: JsonValue;
};

/** The outcome of running a tool call, flagged when it is an error. */
export type AgentToolResultPart = {
	type: 'tool-result';
	toolCallId: string;
	toolName: string;
	output: JsonValue;
	isError: boolean;
};

export type AgentMessagePart =
	| AgentTextPart
	| AgentToolCallPart
	| AgentToolResultPart;

export type AgentMessageRole = 'user' | 'assistant';

/** One finished message: the unit the loop persists, keyed by {@link id}. */
export type AgentMessage = {
	id: string;
	role: AgentMessageRole;
	/** Epoch ms; orders the transcript. */
	createdAt: number;
	parts: AgentMessagePart[];
};

/** Concatenate every text part: the prose view of a message. */
export function agentMessageText(message: AgentMessage): string {
	let text = '';
	for (const part of message.parts) {
		if (part.type === 'text') text += part.text;
	}
	return text;
}

/**
 * A message worth persisting has a non-empty text part or any tool activity. An
 * assistant message that produced nothing (an aborted turn) is dropped.
 */
export function isPersistableMessage(message: AgentMessage): boolean {
	return message.parts.some(
		(part) =>
			(part.type === 'text' && part.text.length > 0) ||
			part.type === 'tool-call' ||
			part.type === 'tool-result',
	);
}

/**
 * Freeze a transcript into a provider prompt. A user message becomes one text
 * message; an assistant message becomes one assistant message (its text plus
 * any tool calls) followed by one `tool` message per tool result, the standard
 * function-calling transcript the model re-reads on each step. Each persisted
 * assistant message holds exactly one round (text, its calls, then their
 * results), so walking messages in order yields a correctly interleaved prompt.
 */
export function toModelMessages(messages: AgentMessage[]): ModelMessage[] {
	const prompt: ModelMessage[] = [];
	for (const message of messages) {
		if (message.role === 'user') {
			const content = agentMessageText(message);
			if (content.length > 0) prompt.push({ role: 'user', content });
			continue;
		}

		const toolCalls: ToolCall[] = [];
		for (const part of message.parts) {
			if (part.type !== 'tool-call') continue;
			toolCalls.push({
				id: part.toolCallId,
				type: 'function',
				function: {
					name: part.toolName,
					arguments: JSON.stringify(part.input),
				},
			});
		}
		prompt.push({
			role: 'assistant',
			content: agentMessageText(message),
			...(toolCalls.length > 0 && { toolCalls }),
		});

		for (const part of message.parts) {
			if (part.type !== 'tool-result') continue;
			prompt.push({
				role: 'tool',
				toolCallId: part.toolCallId,
				name: part.toolName,
				content:
					typeof part.output === 'string'
						? part.output
						: JSON.stringify(part.output),
			});
		}
	}
	return prompt;
}
