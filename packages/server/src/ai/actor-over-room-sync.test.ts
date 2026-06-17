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
 *  1. a designated daemon answers a turn written by another peer, and the
 *     streamed reply propagates back over sync (the V0 exit: "a phone and a
 *     desktop see the same streamed reply over hosted sync");
 *  2. a durable cancel written by another peer stops the answer mid-stream
 *     ("cancel works after a disconnect");
 *  3. designation (R) closes the D3 hazard: a daemon NOT designated to this
 *     conversation abstains, so the cloud HTTP `runDocGeneration` path is the
 *     sole answerer and the merge keeps exactly ONE assistant map. Before R
 *     both paths answered and the cross-replica existence claim could not
 *     serialise, so two assistant maps survived; the daemon's `isDesignated`
 *     gate is what makes the cloud-default conversation single-answered again.
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

/**
 * Wire `attachChatActor` to a body and fire `onChange` on every transaction.
 *
 * `isDesignated` is the daemon's designation gate (R): the always-on actor only
 * claims a turn when the conversation is designated to this node. The mount
 * builds it from `row.actorNodeId === selfNodeId`; here a test passes the
 * decision directly, since the integration suite drives the child doc with no
 * parent row. Omitting it answers everything (the actor's default).
 */
function attachDaemon(
	ydoc: Y.Doc,
	startStream: Parameters<typeof attachChatActor>[0]['startStream'],
	{ isDesignated }: { isDesignated?: () => boolean } = {},
) {
	const transcript = attachChatTranscript(ydoc);
	const actor = attachChatActor({ ydoc, startStream, isDesignated });
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
	test('a designated daemon answers a turn written by another peer, and the reply syncs back', async () => {
		const core = createRoomCore({ updateLog: createMemoryUpdateLog() });

		// The always-on daemon peer, designated to this conversation: a body
		// synced through the room.
		const daemonDoc = new Y.Doc({ gc: true });
		const daemon = attachDaemon(daemonDoc, streamOf('你', '好', '!'), {
			isDesignated: () => true,
		});

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
		const daemon = attachDaemon(daemonDoc, startStream, {
			isDesignated: () => true,
		});

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

	test('designation closes D3: a daemon NOT designated abstains, so the cloud HTTP path is the sole answerer', async () => {
		const core = createRoomCore({ updateLog: createMemoryUpdateLog() });
		const room = {
			getDoc: async () => core.getDoc(),
			sync: async (body: Uint8Array) => core.sync(body),
		};

		// A daemon is running over the same room, but this conversation is
		// cloud-default (`actorNodeId` absent), so it is NOT designated to this
		// node. The daemon hosts and observes the body but must never claim.
		const daemonDoc = new Y.Doc({ gc: true });
		const daemon = attachDaemon(daemonDoc, streamOf('daemon-a', 'daemon-b'), {
			isDesignated: () => false,
		});

		const clientDoc = new Y.Doc({ gc: true });
		const client = attachChatTranscript(clientDoc);

		client.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		syncStep(clientDoc, core);

		// The daemon observes the turn but abstains: nothing claimed on its replica.
		syncStep(daemonDoc, core);
		expect(assistantsFor(attachChatTranscript(daemonDoc), 'gen-1')).toHaveLength(
			0,
		);

		// The browser, seeing a cloud-default conversation, takes the HTTP path:
		// `runDocGeneration` reads the room and claims gen-1. It is now the only
		// peer that answers.
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

		// Exactly one assistant map, and it is the HTTP answer: the undesignated
		// daemon stepped aside, so the cloud-default turn is answered once. This is
		// the D3 double-answer, closed by R's designation gate.
		const answers = assistantsFor(client, 'gen-1');
		expect(answers).toHaveLength(1);
		expect(client.read().find((m) => m.id === 'gen-1')?.text).toBe(
			'http-ahttp-b',
		);

		daemon.dispose();
		daemonDoc.destroy();
		clientDoc.destroy();
	});
});
