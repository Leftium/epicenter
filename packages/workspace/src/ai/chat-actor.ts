/**
 * The per-conversation chat actor: the daemon behavior for one hosted transcript
 * child doc (ADR-0012/0013).
 *
 * `attachChatActor` is the backend-agnostic append loop the always-on actor runs
 * over a conversation transcript. It is parameterized by a {@link ChatStream},
 * the one contract every inference backend speaks:
 *
 * ```txt
 * startStream(messages) => AsyncIterable<StreamChunk>
 * ```
 *
 * A TanStack cloud adapter (`chat({ adapter, messages })`) and a local backend
 * (Ollama / llama.cpp / MLX) look identical to this loop, so swapping the
 * provider is one argument, not a rewrite. The deterministic placeholder reply
 * Zhongwen ships in V0 is just one injected `ChatStream`; the test suite injects
 * its own fixtures the same way.
 *
 * The loop:
 *
 *  - observes the transcript (`onChange` fires once per transaction);
 *  - reconciles the unanswered turn (`findUnansweredTurn`): appends the assistant
 *    message keyed to the turn's client-minted `generationId` (an existence
 *    check, not a lock), then streams the provider's text deltas into its
 *    `Y.Text` and writes a write-once `finish`;
 *  - honors the client-owned durable cancel (`cancelRequestedAt`): mid-stream it
 *    aborts the live stream and writes `finish: cancelled`; a turn cancelled
 *    before it could start is claimed and finished cancelled without streaming.
 *
 * Single writer per field: the client owns the user turn (including the cancel
 * stamp), the actor owns the assistant message (text + finish). The doc itself is
 * the lock, so the only in-memory state is the in-flight stream's abort. Teardown
 * (the row removed, or a daemon shutdown) aborts that stream before the body is
 * destroyed and deliberately writes no finish, leaving an interrupted artifact
 * the client can retry, exactly as an evicted worker would.
 *
 * The flush policy (batching deltas into fewer transactions) is not here yet: the
 * loop appends one delta per chunk. The HTTP generation path
 * (`packages/server/src/ai/doc-generation.ts`) still owns that policy; sharing
 * one stream/flush/finish core between the two is the next collapse.
 *
 * @module
 */

import { EventType, type ModelMessage, type StreamChunk } from '@tanstack/ai';
import type * as Y from 'yjs';
import type { ChildDocActorHandle } from '../document/child-doc-actor.js';
import {
	appendAssistantMessage,
	type ChatDocMessage,
	chatDocToPrompt,
	findUnansweredTurn,
} from './chat-doc.js';

/** Cap for provider error text persisted into the doc; details go to logs. */
const FAILED_MESSAGE_MAX_CHARS = 240;

/**
 * The one contract every inference backend speaks: take the snapshotted prompt,
 * return an async iterable of text-delta (and error) chunks. A TanStack adapter
 * stream and a local model backend are interchangeable behind it.
 */
export type ChatStream = (
	messages: ModelMessage[],
) => AsyncIterable<StreamChunk>;

/** The transcript reads the actor needs: a snapshot of the messages. */
type ChatTranscriptReader = { read(): ChatDocMessage[] };

/** One in-flight generation: enough to cancel it durably. */
type InFlightGeneration = {
	generationId: string;
	controller: AbortController;
	writer: ReturnType<typeof appendAssistantMessage>;
};

/**
 * Build the per-body chat actor for one hosted transcript child doc. Pass the
 * field's declared layout handle, the body `Y.Doc`, and the inference backend as
 * a {@link ChatStream}. The returned handle is what a mount's child-doc actor
 * factory yields.
 */
export function attachChatActor({
	handle,
	ydoc,
	startStream,
}: {
	handle: ChatTranscriptReader;
	ydoc: Y.Doc;
	startStream: ChatStream;
}): ChildDocActorHandle {
	let inFlight: InFlightGeneration | undefined;

	function stop(): void {
		inFlight?.controller.abort();
		inFlight = undefined;
	}

	return {
		onChange() {
			const messages = handle.read();
			const now = Date.now();

			// Durable cancel, mid-stream: if the live generation's turn now carries a
			// client cancel stamp, abort the stream and write the cancelled finish.
			// This runs before the answer path so it is reached even while the
			// existence-based claim would otherwise short-circuit us.
			if (inFlight) {
				const turn = messages.find(
					(message) =>
						message.role === 'user' &&
						message.generationId === inFlight?.generationId,
				);
				if (turn?.cancelRequestedAt !== undefined) {
					inFlight.writer.finish({ kind: 'cancelled' });
					stop();
					return;
				}
			}

			const turn = findUnansweredTurn(messages, now);
			if (!turn) return;

			// Claim synchronously: this append commits before `onChange` returns, so
			// a re-entrant fire sees the id and `findUnansweredTurn` stops it.
			const writer = appendAssistantMessage(ydoc, {
				id: turn.generationId,
				createdAt: now,
			});

			// Durable cancel, pre-stream: the turn was cancelled before we could
			// claim it. Record the cancelled finish and do not stream.
			if (turn.cancelRequestedAt !== undefined) {
				writer.finish({ kind: 'cancelled' });
				return;
			}

			const controller = new AbortController();
			const generation: InFlightGeneration = {
				generationId: turn.generationId,
				controller,
				writer,
			};
			inFlight = generation;
			const prompt = chatDocToPrompt(messages);
			void streamReply(writer, startStream, prompt, controller.signal).finally(
				() => {
					if (inFlight === generation) inFlight = undefined;
				},
			);
		},
		[Symbol.dispose]() {
			// Stop an in-flight stream before the body is torn down. No finish: a
			// teardown leaves an interrupted artifact, not a cancellation.
			inFlight?.controller.abort();
		},
	};
}

/**
 * Drive one provider stream into the assistant message: append each text delta,
 * write a write-once `completed` (or `failed`) finish. A signal abort stops the
 * loop and writes NO finish: the caller's `onChange` already wrote
 * `cancelled` for a durable cancel, and a teardown deliberately leaves the
 * message interrupted (and its `Y.Doc` may already be torn down).
 */
async function streamReply(
	writer: ReturnType<typeof appendAssistantMessage>,
	startStream: ChatStream,
	prompt: ModelMessage[],
	signal: AbortSignal,
): Promise<void> {
	let runError: { code: string; message: string } | undefined;
	try {
		for await (const chunk of startStream(prompt)) {
			if (signal.aborted) return;
			if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
				writer.appendText(chunk.delta);
			} else if (chunk.type === EventType.RUN_ERROR) {
				runError = {
					code: chunk.code ?? 'provider-error',
					message: chunk.message,
				};
			}
		}
	} catch (cause) {
		// Aborting the provider stream surfaces as a throw; that path is the
		// caller's cancel/teardown, not a failure.
		if (signal.aborted) return;
		runError = {
			code: 'stream-error',
			message: cause instanceof Error ? cause.message : String(cause),
		};
	}
	if (signal.aborted) return;
	writer.finish(
		runError
			? {
					kind: 'failed',
					code: runError.code,
					message: runError.message.slice(0, FAILED_MESSAGE_MAX_CHARS),
				}
			: { kind: 'completed' },
	);
}
