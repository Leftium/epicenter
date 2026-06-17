/**
 * The always-on chat actor, reconciling a transcript over a REAL room.
 *
 * Every other actor test drives `onChange` by hand over an in-memory `Y.Doc`
 * with no sync. This suite is the missing end-to-end proof: a daemon peer runs
 * `attachChatActor` over a transcript body that is synced through a live
 * `createRoomCore` (the same room the Durable Object wraps), and a SEPARATE
 * client peer (the asking device) reads the answer back over that sync. The
 * room core is the relay; the two docs never touch each other directly.
 *
 * Three things it proves that no unit test can:
 *  1. the daemon answers a turn written by another peer, and the streamed reply
 *     propagates back over sync (the V0 exit: "a phone and a desktop see the
 *     same streamed reply over hosted sync");
 *  2. a durable cancel written by another peer stops the answer mid-stream
 *     ("cancel works after a disconnect");
 *  3. the D3 hazard is real and concrete: with the daemon actor AND the HTTP
 *     `runDocGeneration` path both answering one room, the cross-replica
 *     existence claim cannot serialise, so the merge keeps TWO assistant maps.
 *     This is the failing-by-design test that the `actorNodeId` designation
 *     (R) must turn green.
 *
 * Peer sync is the same RPC model `doc-generation.test.ts` trusts: a peer pushes
 * its full state with `core.sync(encodeSyncRequest(...))` and applies the diff
 * the room hands back. `syncStep` PUSHES before it APPLIES, so the claim a peer
 * makes while applying an inbound turn is not yet in the room: that ordering is
 * what makes the dual-answer race deterministic instead of timing-dependent.
 */

import { describe, expect, test } from 'bun:test';
import { encodeSyncRequest } from '@epicenter/sync';
import { attachChatActor, attachChatTranscript } from '@epicenter/workspace/ai';
import { EventType, type StreamChunk } from '@tanstack/ai';
import * as Y from 'yjs';
import type { RoomUpdateLog } from '../room/contracts.js';
import { createRoomCore } from '../room/core.js';
import { runDocGeneration } from './doc-generation.js';

// ────────────────────────────────────────────────────────────────────────────
// Harness
// ────────────────────────────────────────────────────────────────────────────

type RoomCore = ReturnType<typeof createRoomCore>;

function createMemoryUpdateLog(): RoomUpdateLog {
	let entries: Uint8Array[] = [];
	return {
		loadAll: () => entries,
		append: (update) => {
			entries.push(update);
		},
		replaceAll: (compacted) => {
			entries = [compacted];
		},
		byteSize: () => entries.reduce((sum, u) => sum + u.byteLength, 0),
		entryCount: () => entries.length,
	};
}

function textChunk(delta: string): StreamChunk {
	return {
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: 'm',
		delta,
	} as StreamChunk;
}

/** A stream that yields each delta with a microtask gap, then ends. */
function streamOf(...deltas: string[]) {
	return async function* (): AsyncGenerator<StreamChunk> {
		for (const delta of deltas) {
			yield textChunk(delta);
			await Promise.resolve();
		}
	};
}

/** A stream that yields `first `, parks until `release()`, then yields `second`. */
function gatedStream() {
	const gate = Promise.withResolvers<void>();
	return {
		startStream: async function* (): AsyncGenerator<StreamChunk> {
			yield textChunk('first ');
			await gate.promise;
			yield textChunk('second');
		},
		release: gate.resolve,
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * One bidirectional sync step for a peer: push its full state to the room, then
 * apply the diff the room is missing back. PUSH happens before APPLY, so a claim
 * the peer makes while applying the inbound update lands in the room only on the
 * NEXT step.
 */
function syncStep(doc: Y.Doc, core: RoomCore): void {
	const { data, error } = core.sync(
		encodeSyncRequest(Y.encodeStateVector(doc), Y.encodeStateAsUpdateV2(doc)),
	);
	if (error) throw error;
	if (data.diff) Y.applyUpdateV2(doc, data.diff);
}

/** Sync every peer, advancing async streams between rounds, until `done()`. */
async function pumpUntil(
	done: () => boolean,
	peers: Y.Doc[],
	core: RoomCore,
	maxRounds = 80,
): Promise<void> {
	for (let round = 0; round < maxRounds; round++) {
		for (const peer of peers) syncStep(peer, core);
		if (done()) return;
		await tick();
	}
	for (const peer of peers) syncStep(peer, core);
	if (!done()) throw new Error(`pumpUntil: condition not met in ${maxRounds} rounds`);
}

/** Sync every peer for a fixed number of rounds (used to drain to quiescence). */
async function pump(peers: Y.Doc[], core: RoomCore, rounds = 40): Promise<void> {
	for (let round = 0; round < rounds; round++) {
		for (const peer of peers) syncStep(peer, core);
		await tick();
	}
}

/** Wire `attachChatActor` to a body and fire `onChange` on every transaction. */
function attachDaemon(
	ydoc: Y.Doc,
	startStream: Parameters<typeof attachChatActor>[0]['startStream'],
) {
	const transcript = attachChatTranscript(ydoc);
	const actor = attachChatActor({ ydoc, startStream });
	const unobserve = transcript.observe(() => actor.onChange?.());
	return {
		transcript,
		dispose() {
			unobserve();
			actor[Symbol.dispose]?.();
		},
	};
}

const assistantsFor = (
	transcript: { read(): { role: string; id: string }[] },
	generationId: string,
) =>
	transcript
		.read()
		.filter((m) => m.role === 'assistant' && m.id === generationId);

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('chat actor over real room sync', () => {
	test('the daemon answers a turn written by another peer, and the reply syncs back', async () => {
		const core = createRoomCore({ updateLog: createMemoryUpdateLog() });

		// The always-on daemon peer: a body synced through the room.
		const daemonDoc = new Y.Doc({ gc: true });
		const daemon = attachDaemon(daemonDoc, streamOf('你', '好', '!'));

		// The asking device: a separate body, same room.
		const clientDoc = new Y.Doc({ gc: true });
		const client = attachChatTranscript(clientDoc);

		// The client asks and syncs the turn up. It never calls an HTTP kickoff.
		client.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		syncStep(clientDoc, core);

		// Drive sync until the asking device sees a finished answer.
		await pumpUntil(
			() => client.read().find((m) => m.id === 'gen-1')?.finish !== undefined,
			[daemonDoc, clientDoc],
			core,
		);

		const messages = client.read();
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({
			id: 'gen-1',
			role: 'assistant',
			text: '你好!',
			finish: { kind: 'completed' },
		});
		// Exactly one answer: the single designated actor did not double-stream.
		expect(assistantsFor(client, 'gen-1')).toHaveLength(1);

		daemon.dispose();
		daemonDoc.destroy();
		clientDoc.destroy();
	});

	test('a durable cancel from another peer stops the daemon mid-answer, over sync', async () => {
		const core = createRoomCore({ updateLog: createMemoryUpdateLog() });
		const { startStream, release } = gatedStream();

		const daemonDoc = new Y.Doc({ gc: true });
		const daemon = attachDaemon(daemonDoc, startStream);

		const clientDoc = new Y.Doc({ gc: true });
		const client = attachChatTranscript(clientDoc);

		client.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		syncStep(clientDoc, core);

		// The daemon claims and streams `first `, then parks at the gate.
		await pumpUntil(
			() => client.read().find((m) => m.id === 'gen-1')?.text === 'first ',
			[daemonDoc, clientDoc],
			core,
		);

		// The asking device cancels durably (no HTTP fetch to abort) and syncs it.
		client.requestCancel(2);
		syncStep(clientDoc, core);

		// The daemon reads the cancel back over sync and finishes cancelled.
		await pumpUntil(
			() => client.read().find((m) => m.id === 'gen-1')?.finish !== undefined,
			[daemonDoc, clientDoc],
			core,
		);

		release(); // unpark the abandoned generator; the aborted loop drops `second`
		await tick();
		syncStep(daemonDoc, core);
		syncStep(clientDoc, core);

		const answer = client.read().find((m) => m.id === 'gen-1');
		expect(answer?.finish).toEqual({ kind: 'cancelled' });
		expect(answer?.text).toBe('first ');

		daemon.dispose();
		daemonDoc.destroy();
		clientDoc.destroy();
	});

	test('D3 hazard, made concrete: daemon actor + HTTP runDocGeneration both answer one turn => two assistant maps', async () => {
		const core = createRoomCore({ updateLog: createMemoryUpdateLog() });
		const room = {
			getDoc: async () => core.getDoc(),
			sync: async (body: Uint8Array) => core.sync(body),
		};

		const daemonDoc = new Y.Doc({ gc: true });
		const daemon = attachDaemon(daemonDoc, streamOf('daemon-a', 'daemon-b'));

		const clientDoc = new Y.Doc({ gc: true });
		const client = attachChatTranscript(clientDoc);

		client.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		syncStep(clientDoc, core);

		// The daemon observes the turn and CLAIMS on its own replica. Because
		// syncStep pushes before it applies, this claim is NOT in the room yet.
		syncStep(daemonDoc, core);
		expect(assistantsFor(attachChatTranscript(daemonDoc), 'gen-1')).toHaveLength(1);

		// The HTTP path reads the room (still just the user turn, no assistant)
		// and ALSO claims gen-1 on a fresh server replica. Neither saw the other.
		const waited: Promise<unknown>[] = [];
		const httpRun = runDocGeneration({
			room,
			signal: new AbortController().signal,
			waitUntil: (promise) => waited.push(promise),
			startStream: streamOf('http-a', 'http-b'),
		});

		await pump([daemonDoc, clientDoc], core, 40);
		await httpRun;
		await Promise.all(waited);
		await pump([daemonDoc, clientDoc], core, 10);

		// The merge keeps BOTH assistant maps keyed to the one generationId: the
		// asking device sees the turn answered twice. This is the live bug R fixes.
		expect(assistantsFor(client, 'gen-1')).toHaveLength(2);

		daemon.dispose();
		daemonDoc.destroy();
		clientDoc.destroy();
	});
});
