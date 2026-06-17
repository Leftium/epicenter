/**
 * Tests for `attachChatActor`: the backend-agnostic chat append loop.
 *
 * The actor is driven directly (the mount wires `observe -> onChange`; here the
 * test calls `onChange` after each write) over a real transcript doc, with the
 * inference backend injected as a fake `ChatStream`. This is the claim -> stream
 * -> finish path V0.3 shipped un-injectable and untested; with `startStream`
 * parameterized it is a fixture, so this suite also covers the V0.4 durable
 * cancel.
 */

import { describe, expect, test } from 'bun:test';
import { EventType, type ModelMessage, type StreamChunk } from '@tanstack/ai';
import * as Y from 'yjs';
import { attachChatActor, type ChatStream } from './chat-actor.js';
import { attachChatTranscript } from './chat-doc.js';

// ────────────────────────────────────────────────────────────────────────────
// Harness
// ────────────────────────────────────────────────────────────────────────────

function textChunk(delta: string): StreamChunk {
	return {
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: 'message-1',
		delta,
	} as StreamChunk;
}

/** A `ChatStream` that yields the given deltas, then ends. */
function streamOf(...deltas: string[]): ChatStream {
	return async function* () {
		for (const delta of deltas) yield textChunk(delta);
	};
}

/**
 * A `ChatStream` that yields `first `, then parks until `release()` before
 * yielding `second`. Lets a test interleave a cancel or teardown mid-stream.
 */
function gatedStream(): { startStream: ChatStream; release: () => void } {
	const gate = Promise.withResolvers<void>();
	return {
		startStream: async function* () {
			yield textChunk('first ');
			await gate.promise;
			yield textChunk('second');
		},
		release: gate.resolve,
	};
}

/** Drain pending microtasks so an in-flight async stream settles. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(startStream: ChatStream) {
	const doc = new Y.Doc({ guid: 'chat-actor-test' });
	const transcript = attachChatTranscript(doc);
	const actor = attachChatActor({ handle: transcript, ydoc: doc, startStream });
	return { doc, transcript, actor };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('attachChatActor', () => {
	test('claims the unanswered turn, streams the reply, writes finish completed', async () => {
		let prompt: ModelMessage[] | undefined;
		const startStream: ChatStream = (messages) => {
			prompt = messages;
			return streamOf('你', '好', '!')(messages);
		};
		const { doc, transcript, actor } = setup(startStream);

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		actor.onChange?.();
		await tick();

		expect(prompt).toEqual([{ role: 'user', content: 'hi' }]);
		const messages = transcript.read();
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ id: 'u1', role: 'user', text: 'hi' });
		expect(messages[1]).toMatchObject({
			id: 'gen-1',
			role: 'assistant',
			text: '你好!',
			finish: { kind: 'completed' },
		});
		doc.destroy();
	});

	test('a re-fire after completion is a no-op (the answer already exists)', async () => {
		const { doc, transcript, actor } = setup(streamOf('done'));

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		actor.onChange?.();
		await tick();
		const after = transcript.read();

		// A re-fire (e.g. our own finish write waking onChange) must not claim again.
		actor.onChange?.();
		await tick();
		expect(transcript.read()).toEqual(after);
		expect(transcript.read()).toHaveLength(2);
		doc.destroy();
	});

	test('a provider RUN_ERROR writes finish failed and keeps the streamed text', async () => {
		const startStream: ChatStream = async function* () {
			yield textChunk('partial');
			yield {
				type: EventType.RUN_ERROR,
				message: 'model exploded',
				code: 'provider-overloaded',
			} as StreamChunk;
		};
		const { doc, transcript, actor } = setup(startStream);

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		actor.onChange?.();
		await tick();

		expect(transcript.read().at(-1)).toMatchObject({
			text: 'partial',
			finish: {
				kind: 'failed',
				code: 'provider-overloaded',
				message: 'model exploded',
			},
		});
		doc.destroy();
	});

	test('a durable cancel mid-stream aborts and writes finish cancelled', async () => {
		const { startStream, release } = gatedStream();
		const { doc, transcript, actor } = setup(startStream);

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		actor.onChange?.();
		await tick(); // 'first ' appended; the stream is parked at the gate

		// The client stamps the cancel on its own turn; the next observe honors it.
		transcript.requestCancel(2);
		actor.onChange?.();

		release(); // unpark the stream; the aborted loop must not append 'second'
		await tick();

		const trailing = transcript.read().at(-1);
		expect(trailing?.text).toBe('first ');
		expect(trailing?.finish).toEqual({ kind: 'cancelled' });
		doc.destroy();
	});

	test('a turn cancelled before it could start is claimed and finished cancelled without streaming', async () => {
		let started = false;
		const startStream: ChatStream = (messages) => {
			started = true;
			return streamOf('should never run')(messages);
		};
		const { doc, transcript, actor } = setup(startStream);

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		// Cancel arrives before the actor observes the turn at all.
		transcript.requestCancel(2);
		actor.onChange?.();
		await tick();

		expect(started).toBe(false);
		const trailing = transcript.read().at(-1);
		expect(trailing).toMatchObject({
			id: 'gen-1',
			role: 'assistant',
			finish: { kind: 'cancelled' },
		});
		doc.destroy();
	});

	test('teardown stops the stream and leaves an interrupted artifact (no finish)', async () => {
		const { startStream, release } = gatedStream();
		const { doc, transcript, actor } = setup(startStream);

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		actor.onChange?.();
		await tick(); // 'first ' appended; the stream is parked

		// A teardown (row removed or daemon shutdown) aborts without finishing.
		actor[Symbol.dispose]?.();
		release();
		await tick();

		const trailing = transcript.read().at(-1);
		expect(trailing?.text).toBe('first ');
		expect(trailing?.finish).toBeUndefined();
		doc.destroy();
	});
});
