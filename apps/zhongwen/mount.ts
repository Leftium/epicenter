/**
 * Zhongwen mount.
 *
 * `zhongwen()` returns the `Mount` that an `epicenter.config.ts`
 * default-exports. Zhongwen has no daemon actions to add and no materializers,
 * so the daemon hosts the root Y.Doc on disk and bridges cloud sync, then runs
 * one child-doc actor: an always-on observe loop (ADR-0012/0013) over the
 * `conversations.messages` transcripts. Registering the field is all the app
 * declares; the table, the guid, and the layout come from the schema. The
 * factory is the behavior seam, and V0.3 fills it with claim -> stream -> finish.
 *
 * V0.3 streams a FAKE deterministic reply: the actor observes the transcript,
 * claims the unanswered user turn on its client-minted `generationId` (an
 * existence check, not a lock), appends the assistant message, streams a
 * placeholder reply into its `Y.Text`, and writes a write-once `finish`. No
 * HTTP, no `room.sync` forwarding (the connected body persists and syncs
 * itself), no duplicate stream. Real provider/local inference lands in V0.5
 * behind `startStream`; the durable cancel lands in V0.4.
 */

import type { ChildDocActorHandle } from '@epicenter/workspace';
import {
	appendAssistantMessage,
	attachChatTranscript,
	findActiveChatDocGeneration,
	findLatestUserTurn,
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

/**
 * The per-conversation child-doc actor: observe -> claim -> stream -> finish.
 *
 * `onChange` fires once per transcript transaction (a new user turn, our own
 * token appends, a finish write). The doc itself is the lock, so the only
 * in-memory state is the in-flight stream's abort:
 *
 *  - the latest user turn carries the client-minted `generationId` that names
 *    the assistant answer it awaits, doubling as that answer's message id;
 *  - if a message already carries that id the turn is claimed (or answered), so
 *    we return: the assistant map appended on claim IS the idempotent claim, not
 *    a lock, and that same check short-circuits our own streaming writes;
 *  - `findActiveChatDocGeneration` serialises turns, so a second user turn that
 *    arrives mid-stream waits for the live one to finish, then gets claimed when
 *    the finish write wakes `onChange` again.
 *
 * The abort exists only so teardown (the row removed, or a daemon shutdown)
 * stops the loop before the body is destroyed. V0.4 adds the durable cancel (the
 * client writes `cancelRequestedAt`; the actor observes it mid-stream and writes
 * `finish: cancelled`), the read-back departure from `doc-generation.ts`.
 */
function createChatActor(
	handle: ChatTranscript,
	ydoc: Y.Doc,
): ChildDocActorHandle {
	let inFlight: AbortController | undefined;

	return {
		onChange() {
			const messages = handle.read();
			const latestUserTurn = findLatestUserTurn(messages);
			// No user turn, or one synced without a generationId, is nothing to
			// answer yet. Narrowing on the optional chain keeps `latestUserTurn`
			// defined below.
			if (latestUserTurn?.generationId === undefined) return;
			const { generationId } = latestUserTurn;
			// Existence IS the claim: the assistant map keyed to this id means the
			// turn is claimed or answered. This also short-circuits our own
			// streaming writes, so the loop never re-enters itself.
			if (messages.some((message) => message.id === generationId)) return;
			const startedAt = Date.now();
			// A live (recent, unfinished) assistant turn serialises generations: a
			// turn that arrived mid-stream waits here until the finish write wakes us.
			if (findActiveChatDocGeneration(messages, startedAt)) return;

			// Claim synchronously: this append commits before `onChange` returns, so
			// a re-entrant fire sees the id and the existence check above stops it.
			const writer = appendAssistantMessage(ydoc, {
				id: generationId,
				createdAt: startedAt,
			});
			const controller = new AbortController();
			inFlight = controller;
			void streamFakeReply(
				writer,
				latestUserTurn.text,
				controller.signal,
			).finally(() => {
				if (inFlight === controller) inFlight = undefined;
			});
		},
		[Symbol.dispose]() {
			// Stop an in-flight stream before the body is torn down.
			inFlight?.abort();
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
