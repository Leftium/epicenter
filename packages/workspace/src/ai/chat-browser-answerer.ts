/**
 * The browser trigger wrapper: an in-process answerer for a conversation a
 * browser tab answers itself (ADR-0021's `in-process` trigger).
 *
 * A cloud-runtime conversation is answered by the hosted kickoff
 * (`packages/server/src/ai/doc-generation.ts`); a daemon-bound conversation is
 * answered ambiently by {@link attachChatReaction}; a BYOK/local conversation
 * the browser owns is answered here, in the tab, with no HTTP transport for the
 * answer (only the inference call, if any, leaves). All three write parts into
 * the same conversation doc through the same writer, and the client always
 * renders the doc (ADR-0021).
 *
 * This is deliberately the *same* answerer as the daemon: it builds an
 * {@link attachChatReaction} over the local transcript doc and wires its
 * `onChange` to the doc's own observer, exactly as the daemon mount's child-doc
 * runtime does (`attachChildDocReactions` calls `handle.observe(() =>
 * reaction.onChange())`). So the claim is the identical existence-based claim
 * (`findUnansweredTurn`): a browser answerer and a future daemon on the same
 * conversation reconcile the same predicate and never double-answer one turn
 * (the message keyed to the turn's `generationId` is the claim, whoever appends
 * it first). The browser does NOT run this for a cloud-runtime conversation; the
 * app fires the kickoff instead (the trigger fork, kept).
 *
 * The lifecycle matches the daemon too. On the user's durable cancel
 * (`requestCancel` writes `cancelRequestedAt`) the reaction aborts the stream and
 * writes `cancelled`. On teardown (the tab navigates away or the handle is
 * disposed mid-answer) it aborts and writes no finish, leaving an interrupted
 * artifact the user can retry, exactly as an evicted daemon would. That is the
 * correct browser behavior: a closed tab is an interrupted answer, not a
 * cancellation.
 *
 * @module
 */

import type * as Y from 'yjs';
import type { ChatStream } from './chat-answer.js';
import { observeChatDocMessages } from './chat-doc.js';
import { attachChatReaction } from './chat-reaction.js';

/**
 * Run an in-process answerer over a local conversation doc and return a stop
 * function. Pass the transcript body `Y.Doc` and the inference backend as a
 * {@link ChatStream} (a local model, the user's BYOK provider, or the Epicenter
 * provider that calls the metered inference endpoint).
 *
 * Wiring mirrors the daemon mount: observe the transcript, fire the reaction's
 * `onChange` per transaction, and fire it once now so a turn already pending at
 * attach time (synced from another device, or this tab reopened mid-conversation)
 * is reconciled immediately. The returned stop function unobserves and disposes
 * the reaction (aborting any in-flight stream without writing a finish).
 */
export function attachChatBrowserAnswerer({
	doc,
	startStream,
}: {
	doc: Y.Doc;
	startStream: ChatStream;
}): () => void {
	const reaction = attachChatReaction({ ydoc: doc, startStream });
	const unobserve = observeChatDocMessages(doc, () => reaction.onChange?.());
	// Claim a turn already pending when the answerer attaches.
	reaction.onChange?.();
	return () => {
		unobserve();
		reaction[Symbol.dispose]?.();
	};
}
