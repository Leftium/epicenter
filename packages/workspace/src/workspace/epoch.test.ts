/**
 * Epoch Tracker Tests
 *
 * Verifies the per-client epoch map that coordinates epoch-based compaction.
 * The coordination doc is a Y.Map where each key is a client ID and each value is
 * that client's proposed epoch. The current epoch is MAX(all values).
 *
 * Key behaviors:
 * - getEpoch returns MAX of all client proposals (0 when empty)
 * - bumpEpoch writes MAX+1 under this client's ID
 * - Concurrent bumps from multiple clients converge via MAX
 * - observeEpoch fires on any client's epoch change
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { createEpochTracker } from './epoch.js';

function setup() {
	const ydoc = new Y.Doc();
	const tracker = createEpochTracker(ydoc);
	return { ydoc, tracker };
}

describe('createEpochTracker', () => {
	test('getEpoch returns 0 for empty epoch map', () => {
		const { tracker } = setup();
		expect(tracker.getEpoch()).toBe(0);
	});

	test('bumpEpoch increments from 0 to 1', () => {
		const { tracker } = setup();
		const next = tracker.bumpEpoch();
		expect(next).toBe(1);
		expect(tracker.getEpoch()).toBe(1);
	});

	test('bumpEpoch increments from current MAX', () => {
		const { tracker } = setup();
		tracker.bumpEpoch(); // → 1
		tracker.bumpEpoch(); // → 2
		expect(tracker.getEpoch()).toBe(2);
	});

	test('concurrent bumps from two clients converge to same epoch', () => {
		// Simulate two clients sharing state via Y.Doc sync
		const ydocA = new Y.Doc();
		const ydocB = new Y.Doc();
		const trackerA = createEpochTracker(ydocA);
		const trackerB = createEpochTracker(ydocB);

		// Both read epoch 0, both bump to 1
		trackerA.bumpEpoch(); // A writes { clientA: 1 }
		trackerB.bumpEpoch(); // B writes { clientB: 1 }

		// Sync: exchange updates
		Y.applyUpdate(ydocB, Y.encodeStateAsUpdate(ydocA));
		Y.applyUpdate(ydocA, Y.encodeStateAsUpdate(ydocB));

		// Both converge to MAX(1, 1) = 1
		expect(trackerA.getEpoch()).toBe(1);
		expect(trackerB.getEpoch()).toBe(1);
	});

	test('staggered bumps: later client sees higher epoch', () => {
		const ydocA = new Y.Doc();
		const ydocB = new Y.Doc();
		const trackerA = createEpochTracker(ydocA);
		const trackerB = createEpochTracker(ydocB);

		trackerA.bumpEpoch(); // A → 1
		trackerA.bumpEpoch(); // A → 2

		// Sync A→B
		Y.applyUpdate(ydocB, Y.encodeStateAsUpdate(ydocA));

		// B now sees epoch 2, bumps to 3
		expect(trackerB.getEpoch()).toBe(2);
		trackerB.bumpEpoch();
		expect(trackerB.getEpoch()).toBe(3);
	});

	test('observeEpoch fires on epoch change', () => {
		const { tracker } = setup();
		const observed: number[] = [];
		tracker.observeEpoch((epoch) => observed.push(epoch));

		tracker.bumpEpoch();
		tracker.bumpEpoch();

		expect(observed).toEqual([1, 2]);
	});

	test('observeEpoch unsubscribe stops notifications', () => {
		const { tracker } = setup();
		const observed: number[] = [];
		const unsub = tracker.observeEpoch((epoch) => observed.push(epoch));

		tracker.bumpEpoch();
		unsub();
		tracker.bumpEpoch();

		expect(observed).toEqual([1]);
	});

	test('observeEpoch fires when remote client bumps via sync', () => {
		const ydocA = new Y.Doc();
		const ydocB = new Y.Doc();
		const trackerA = createEpochTracker(ydocA);
		const trackerB = createEpochTracker(ydocB);

		const observed: number[] = [];
		trackerB.observeEpoch((epoch) => observed.push(epoch));

		// A bumps, sync to B
		trackerA.bumpEpoch();
		Y.applyUpdate(ydocB, Y.encodeStateAsUpdate(ydocA));

		expect(observed).toEqual([1]);
	});
});
