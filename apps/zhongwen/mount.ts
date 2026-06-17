/**
 * Zhongwen mount.
 *
 * `zhongwen()` returns the `Mount` that an `epicenter.config.ts`
 * default-exports. Zhongwen has no daemon actions to add and no materializers,
 * so the daemon hosts the root Y.Doc on disk and bridges cloud sync, then runs
 * one child-doc actor: an always-on observe loop (ADR-0012/0013) over the
 * `conversations.messages` transcripts. Registering the field is all the app
 * declares; the table, the guid, and the layout come from the schema. The
 * factory is the behavior seam, filled here with observe -> answer -> stream ->
 * finish plus the durable cancel.
 *
 * The actor reconciles the unanswered turn (`findUnansweredTurn`): it appends
 * the assistant message keyed to the turn's client-minted `generationId` (an
 * existence check, not a lock), streams a FAKE placeholder reply into its
 * `Y.Text`, and writes a write-once `finish`. No HTTP, no `room.sync` forwarding
 * (the connected body persists and syncs itself), no duplicate stream.
 *
 * V0.4 adds the durable cancel: the client stamps `cancelRequestedAt` on its own
 * turn, and the actor reads it back (mid-stream, or before it could start) and
 * writes `finish: cancelled`. That read-back is the departure from the
 * snapshot-once HTTP actor in `doc-generation.ts`. Real provider/local inference
 * lands in V0.5 behind `startStream`; the append loop stays the same.
 */

import type { ChildDocActorHandle } from '@epicenter/workspace';
import {
	appendAssistantMessage,
	attachChatTranscript,
	findUnansweredTurn,
} from '@epicenter/workspace/ai';
import { nodeMountRuntime } from '@epicenter/workspace/node';
import type * as Y from 'yjs';
import { zhongwenWorkspace } from './zhongwen.js';

export type ZhongwenMountOptions = {
	/**
	 * Base URL of the Epicenter cloud API used for sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
};

export function zhongwen({ baseURL }: ZhongwenMountOptions = {}) {
	return zhongwenWorkspace.mount({
		baseURL,
		runtime: nodeMountRuntime(),
		actors: {
			conversations: {
				messages: ({ handle, ydoc }) => createChatActor(handle, ydoc),
			},
		},
	});
}

/** The transcript handle the `conversations.messages` layout hands the actor. */
type ChatTranscript = ReturnType<typeof attachChatTranscript>;

/** The assistant-message writer the actor streams a single turn through. */
type AssistantWriter = ReturnType<typeof appendAssistantMessage>;

/** The state one in-flight generation carries: enough to cancel it durably. */
type InFlightGeneration = {
	generationId: string;
	controller: AbortController;
	writer: AssistantWriter;
};

/**
 * The per-conversation child-doc actor: observe -> answer -> stream -> finish,
 * honoring the durable cancel.
 *
 * `onChange` fires once per transcript transaction (a new user turn, our own
 * token appends, a finish write, the client's cancel stamp). The doc itself is
 * the lock, so the only in-memory state is the in-flight generation:
 *
 *  - the answerable turn (`findUnansweredTurn`) carries the client-minted
 *    `generationId` that names the assistant answer it awaits, doubling as that
 *    answer's message id; appending the assistant map keyed to that id IS the
 *    existence-based claim, so a re-entrant fire short-circuits;
 *  - a recent unfinished assistant turn serialises generations, so a second user
 *    turn that arrives mid-stream waits until the finish write wakes us again;
 *  - the client owns `cancelRequestedAt` on its own turn. We read it back: a
 *    mid-stream cancel aborts the live stream and writes `finish: cancelled`; a
 *    turn already cancelled before we could start is claimed and finished
 *    cancelled without streaming.
 *
 * The abort also covers teardown (the row removed, or a daemon shutdown),
 * stopping the loop before the body is destroyed; that path skips the finish,
 * leaving an interrupted artifact the client can retry.
 */
function createChatActor(
	handle: ChatTranscript,
	ydoc: Y.Doc,
): ChildDocActorHandle {
	let inFlight: InFlightGeneration | undefined;

	function stop(): void {
		inFlight?.controller.abort();
		inFlight = undefined;
	}

	return {
		onChange() {
			const messages = handle.read();
			const now = Date.now();

			// Durable cancel, mid-stream: if the live generation's turn now carries
			// a client cancel stamp, abort the stream and write the cancelled finish.
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
			inFlight = { generationId: turn.generationId, controller, writer };
			void streamFakeReply(writer, turn.text, controller.signal).finally(() => {
				if (inFlight?.controller === controller) inFlight = undefined;
			});
		},
		[Symbol.dispose]() {
			// Stop an in-flight stream before the body is torn down.
			inFlight?.controller.abort();
		},
	};
}

/**
 * Stream a deterministic placeholder reply into the assistant `Y.Text`, one
 * token append per word, then write a write-once `completed` finish.
 *
 * A teardown abort stops the loop and skips the finish, leaving an interrupted
 * artifact the client can retry once it ages past the active-generation window,
 * exactly as an evicted worker would. Real provider/local inference replaces
 * this in V0.5 behind the `startStream(messages) => AsyncIterable<StreamChunk>`
 * contract; the append loop stays the same.
 */
async function streamFakeReply(
	writer: ReturnType<typeof appendAssistantMessage>,
	userText: string,
	signal: AbortSignal,
): Promise<void> {
	const reply = `Received: "${userText.trim()}". This is a placeholder reply streamed by the always-on actor; real inference lands in V0.5.`;
	for (const token of reply.match(/\S+\s*/g) ?? [reply]) {
		if (signal.aborted) return;
		writer.appendText(token);
		// Yield between tokens so each append is its own synced transaction and a
		// teardown abort can land between them.
		await Promise.resolve();
	}
	if (!signal.aborted) writer.finish({ kind: 'completed' });
}
