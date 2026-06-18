/**
 * Doc-as-wire generation reaction.
 *
 * Streams one assistant turn into a conversation Y.Doc by acting as a sync
 * peer of the room that owns it:
 *
 *  1. `room.getDoc()` hydrates a local replica.
 *  2. The replica is validated (idempotency, single active generation,
 *     a user message to respond to).
 *  3. The prompt is snapshotted from the replica; concurrent user messages
 *     appended mid-generation commute and join the NEXT turn's snapshot.
 *  4. An assistant message map is appended (the "thinking" marker), then
 *     provider text deltas are flushed into its Y.Text.
 *  5. Every local transaction's updateV2 bytes are forwarded to
 *     `room.sync(encodeSyncRequest(replicaStateVector, update))`. The state
 *     vector is the replica's own current one; an empty vector would make
 *     the room echo the full doc back as a diff on every flush.
 *  6. The terminal `finish` key is written exactly once: `completed`,
 *     `cancelled` (kickoff fetch aborted / client disconnected), or
 *     `failed` (provider error, sanitized).
 *
 * The reaction never reads room diffs back mid-generation and never touches
 * any message map it did not create (append-only, single writer per map).
 *
 * Runtime-agnostic: drives any {@link ResolvedRoom} (Durable Object stub in
 * production, an in-process `createRoomCore` wrapper in tests) and any
 * `AsyncIterable<StreamChunk>` (TanStack `chat()` in production, a fake
 * generator in tests).
 */

import { AiChatError } from '@epicenter/constants/ai-chat-errors';
import { encodeSyncRequest } from '@epicenter/sync';
import {
	appendAssistantMessage,
	type ChatDocFinish,
	chatDocToPrompt,
	findActiveChatDocGeneration,
	findLatestUserTurn,
	readChatDocMessages,
	streamAnswer,
} from '@epicenter/workspace/ai';
import type { ModelMessage, StreamChunk } from '@tanstack/ai';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Ok } from 'wellcrafted/result';
import * as Y from 'yjs';
import type { ResolvedRoom } from '../room/contracts.js';

const log = createLogger('server/ai/doc-generation');

/** Log-only diagnostics; never surfaced on the wire. */
const DocGenerationError = defineErrors({
	StreamFailed: ({
		generationId,
		cause,
	}: {
		generationId: string;
		cause: unknown;
	}) => ({
		message: `doc generation ${generationId} stream threw: ${extractErrorMessage(cause)}`,
		generationId,
		cause,
	}),
	UpdatesUndelivered: ({
		generationId,
		count,
	}: {
		generationId: string;
		count: number;
	}) => ({
		message: `doc generation ${generationId}: ${count} update(s) never reached the room`,
		generationId,
		count,
	}),
	SyncFailed: ({
		generationId,
		cause,
	}: {
		generationId: string;
		cause: unknown;
	}) => ({
		message: `doc generation ${generationId} room.sync failed: ${extractErrorMessage(cause)}`,
		generationId,
		cause,
	}),
});

/** Cap for provider error text persisted into the doc; details go to logs. */
const FAILED_MESSAGE_MAX_CHARS = 240;

export async function runDocGeneration({
	room,
	signal,
	waitUntil,
	startStream,
}: {
	/** The room that owns the conversation doc. */
	room: Pick<ResolvedRoom, 'getDoc' | 'sync'>;
	/**
	 * Aborts when the client stops or disconnects. The caller also wires it
	 * into the provider stream; here it classifies the terminal outcome
	 * (`cancelled` vs `failed`) and routes the final sync through
	 * `waitUntil`, since the request is already dead on this path.
	 */
	signal: AbortSignal;
	/** `ctx.waitUntil`: keeps the cancelled-finish sync alive post-response. */
	waitUntil: (promise: Promise<unknown>) => void;
	/** Provider stream factory; receives the snapshotted prompt. */
	startStream: (messages: ModelMessage[]) => AsyncIterable<StreamChunk>;
}) {
	const snapshot = await room.getDoc();
	const replica = new Y.Doc({ gc: true });
	Y.applyUpdateV2(replica, snapshot.data);

	const messages = readChatDocMessages(replica);

	// The unanswered user turn IS the work queue: its client-minted
	// `generationId` is the identity the reaction reads from the doc, not from an
	// HTTP body. No user turn (or one synced without a generationId) means there
	// is nothing valid to answer yet.
	const latestUserTurn = findLatestUserTurn(messages);
	if (latestUserTurn?.generationId === undefined) {
		replica.destroy();
		return AiChatError.NoUserMessage();
	}
	// Narrowed to `string`, so the capturing closures below see it as defined.
	const generationId = latestUserTurn.generationId;
	if (messages.some((message) => message.id === generationId)) {
		replica.destroy();
		return AiChatError.GenerationAlreadyExists({ generationId });
	}
	const startedAt = Date.now();
	if (findActiveChatDocGeneration(messages, startedAt)) {
		replica.destroy();
		return AiChatError.GenerationInProgress();
	}

	// Prompt frozen at kickoff. `chatDocToPrompt` (the transcript's own prompt
	// owner) drops empty messages, e.g. an interrupted assistant turn that never
	// received a token.
	const prompt = chatDocToPrompt(messages);

	// ── Update forwarding ────────────────────────────────────────────────
	// One transaction = one updateV2 event. Updates queue in `unsent` and a
	// serial send chain forwards them; a failed send re-queues its batch so
	// a later flush (or the final drain) retries the merged backlog. Yjs
	// updates are idempotent and commutative, so resending is safe.
	let unsent: Uint8Array[] = [];
	let sendChain: Promise<void> = Promise.resolve();
	replica.on('updateV2', (update: Uint8Array) => {
		unsent.push(update);
		scheduleSend();
	});

	function scheduleSend(): void {
		sendChain = sendChain.then(async () => {
			if (unsent.length === 0) return;
			const batch = unsent;
			unsent = [];
			const update = batch.length === 1 ? batch[0]! : Y.mergeUpdatesV2(batch);
			const body = encodeSyncRequest(Y.encodeStateVector(replica), update);
			// room.sync is a Durable Object RPC: it REJECTS on isolate
			// eviction or transport failure (it only returns Err for a
			// malformed body, which we never send). Both the rejection and the
			// Err re-queue the batch so a later flush or the final drain retries
			// it; sendChain itself must never reject, or drain's await would
			// throw out of the reaction. Yjs updates are idempotent, so resending
			// is safe.
			try {
				const { error } = await room.sync(body);
				if (error) {
					unsent = [...batch, ...unsent];
					log.warn(error);
				}
			} catch (cause) {
				unsent = [...batch, ...unsent];
				log.warn(DocGenerationError.SyncFailed({ generationId, cause }));
			}
		});
	}

	/** Retry until every queued update reached the room (or attempts run out). */
	async function drain(): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			scheduleSend();
			await sendChain;
			if (unsent.length === 0) {
				replica.destroy();
				return;
			}
		}
		replica.destroy();
		log.error(
			DocGenerationError.UpdatesUndelivered({
				generationId,
				count: unsent.length,
			}),
		);
	}

	// ── Stream into the doc ──────────────────────────────────────────────
	// The append itself is the "thinking" marker: an empty trailing
	// assistant map with a recent createdAt.
	const writer = appendAssistantMessage(replica, {
		id: generationId,
		createdAt: startedAt,
	});

	// The shared answer core owns the loop, the flush policy, and the chunk
	// switch. `startStream` here already has the signal wired in by the caller,
	// so it ignores the core's signal argument; the signal still classifies the
	// terminal outcome below.
	const { aborted, runError, tail } = await streamAnswer({
		writer,
		startStream,
		prompt,
		signal,
	});

	// A thrown stream error (not a RUN_ERROR event) carries its cause; log it.
	if (runError?.cause !== undefined) {
		log.error(
			DocGenerationError.StreamFailed({ generationId, cause: runError.cause }),
		);
	}

	// The cloud finish policy: a client disconnect is `cancelled` (written here,
	// unlike the daemon), a provider error is `failed`, otherwise `completed`.
	const finish: ChatDocFinish = aborted
		? { kind: 'cancelled' }
		: runError
			? {
					kind: 'failed',
					code: runError.code,
					message: runError.message.slice(0, FAILED_MESSAGE_MAX_CHARS),
				}
			: { kind: 'completed' };

	// Final transaction: remaining buffered text plus the finish key.
	writer.finish(finish, { text: tail });

	if (signal.aborted) {
		// The client is gone; the response will never be read. Keep the
		// isolate alive just long enough for the cancelled finish to sync.
		waitUntil(drain());
	} else {
		await drain();
	}

	return Ok({ finish });
}
