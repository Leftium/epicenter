/**
 * Awareness Wake Clock Regression
 *
 * The Room DO seeds awareness state for every hibernated client at wake
 * (`apps/api/src/room.ts`). y-protocols accepts a non-null awareness update
 * only when its `clock` is strictly greater than the locally stored
 * `meta.clock`. A seed of `1` would tie the client's first post-wake frame
 * at clock `1` and silently drop it; the seed of `0` lets the same frame
 * pass the accept gate.
 *
 * These tests do not exercise the DO itself (Bun's runtime lacks the
 * Cloudflare Workers globals it depends on); they exercise the y-protocols
 * contract the seed relies on. If a future y-protocols update relaxes the
 * comparison (or makes it inclusive), these tests fail and the seed value
 * needs revisiting.
 */

import { expect, test } from 'bun:test';
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import * as Y from 'yjs';

const HIBERNATED_CLIENT_ID = 42;

/**
 * Build the server-side awareness that `room.ts` produces after hibernation
 * wake: states[clientID] = { liveness }, meta[clientID] = { clock, lastUpdated }.
 */
function serverAwarenessAfterWake(seedClock: number) {
	const doc = new Y.Doc();
	const awareness = new Awareness(doc);
	awareness.setLocalState(null); // relay does not participate

	awareness.states.set(HIBERNATED_CLIENT_ID, {
		liveness: { installationId: 'install-1' },
	});
	awareness.meta.set(HIBERNATED_CLIENT_ID, {
		clock: seedClock,
		lastUpdated: Date.now(),
	});

	return { doc, awareness };
}

/**
 * Build a y-protocols awareness wire frame that asserts `clientID = 42` is at
 * the requested clock and carries the given state. Encoding from `Awareness`
 * reads from `awareness.states` and `awareness.meta` for that clientID, so we
 * seed them and let `encodeAwarenessUpdate` produce a real, parseable frame.
 */
function clientFrameAtClock(state: Record<string, unknown>, clock: number) {
	const doc = new Y.Doc();
	const awareness = new Awareness(doc);
	// Pin clientID so the resulting frame addresses the same client the
	// server's wake-restore is keyed on.
	awareness.clientID = HIBERNATED_CLIENT_ID;
	awareness.states.set(HIBERNATED_CLIENT_ID, state);
	awareness.meta.set(HIBERNATED_CLIENT_ID, {
		clock,
		lastUpdated: Date.now(),
	});
	return encodeAwarenessUpdate(awareness, [HIBERNATED_CLIENT_ID]);
}

test('wake seed at clock 0 accepts the client first frame at clock 1', () => {
	const { awareness } = serverAwarenessAfterWake(0);

	const frame = clientFrameAtClock(
		{
			liveness: { installationId: 'install-1' },
			cursor: { line: 7 },
		},
		1,
	);

	applyAwarenessUpdate(awareness, frame, 'test');

	expect(awareness.states.get(HIBERNATED_CLIENT_ID)).toEqual({
		liveness: { installationId: 'install-1' },
		cursor: { line: 7 },
	});
	expect(awareness.meta.get(HIBERNATED_CLIENT_ID)?.clock).toBe(1);
});

test('regression: wake seed at clock 1 would swallow the client first frame at clock 1', () => {
	// This test documents the bug fixed in commit 04f5d4c4 by reproducing the
	// pre-fix server seed value. If this test starts failing, y-protocols has
	// relaxed its accept gate and the seed value no longer matters in the
	// edge case it was protecting against.
	const { awareness } = serverAwarenessAfterWake(1);

	const frame = clientFrameAtClock(
		{
			liveness: { installationId: 'install-1' },
			cursor: { line: 7 },
		},
		1,
	);

	applyAwarenessUpdate(awareness, frame, 'test');

	// With a server seed of clock 1, the y-protocols accept gate
	// (strict `currClock < incomingClock`) rejects the incoming clock 1
	// frame. The server's view stays at the seeded liveness-only state.
	expect(awareness.states.get(HIBERNATED_CLIENT_ID)).toEqual({
		liveness: { installationId: 'install-1' },
	});
	expect(awareness.meta.get(HIBERNATED_CLIENT_ID)?.clock).toBe(1);
});

test('wake seed at clock 0 still accepts higher subsequent client clocks', () => {
	// Sanity: the seed of 0 does not pin the client to clock 1; subsequent
	// frames at clock 5 should also be accepted.
	const { awareness } = serverAwarenessAfterWake(0);

	applyAwarenessUpdate(
		awareness,
		clientFrameAtClock({ liveness: { installationId: 'install-1' } }, 1),
		'test',
	);
	applyAwarenessUpdate(
		awareness,
		clientFrameAtClock(
			{
				liveness: { installationId: 'install-1' },
				cursor: { line: 42 },
			},
			5,
		),
		'test',
	);

	expect(awareness.states.get(HIBERNATED_CLIENT_ID)).toEqual({
		liveness: { installationId: 'install-1' },
		cursor: { line: 42 },
	});
	expect(awareness.meta.get(HIBERNATED_CLIENT_ID)?.clock).toBe(5);
});
