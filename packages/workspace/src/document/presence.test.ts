/**
 * Tests for the server-owned presence tracker.
 *
 * Exercises `createPresenceTracker` in isolation: frame parsing,
 * self-exclusion, subscription notifications, reset semantics, and the
 * `hasSnapshot` gate that `run-handler.ts` relies on to suppress
 * `PeerNotFound` during the pre-snapshot window.
 */

import { describe, expect, test } from 'bun:test';
import {
	createPresenceTracker,
	type PresenceAddedFrame,
	type PresenceRemovedFrame,
	type PresenceSnapshotFrame,
} from './presence.js';

const SELF = 'self-install';

function snapshotFrame(installs: string[]): string {
	return JSON.stringify({
		type: 'presence_snapshot',
		installs,
	} satisfies PresenceSnapshotFrame);
}

function addedFrame(install: string): string {
	return JSON.stringify({
		type: 'presence_added',
		install,
	} satisfies PresenceAddedFrame);
}

function removedFrame(install: string): string {
	return JSON.stringify({
		type: 'presence_removed',
		install,
	} satisfies PresenceRemovedFrame);
}

describe('createPresenceTracker', () => {
	test('hasSnapshot is false until the first snapshot is applied', () => {
		const p = createPresenceTracker(SELF);
		expect(p.hasSnapshot).toBe(false);

		p.handleFrame(snapshotFrame([]));
		expect(p.hasSnapshot).toBe(true);
	});

	test('handleFrame parses snapshot and replaces the set', () => {
		const p = createPresenceTracker(SELF);

		const consumed = p.handleFrame(snapshotFrame(['mac', 'phone']));
		expect(consumed).toBe(true);
		expect(p.list()).toEqual([
			{ installationId: 'mac' },
			{ installationId: 'phone' },
		]);

		// A second snapshot replaces, not appends.
		p.handleFrame(snapshotFrame(['laptop']));
		expect(p.list()).toEqual([{ installationId: 'laptop' }]);
	});

	test('handleFrame parses presence_added and presence_removed', () => {
		const p = createPresenceTracker(SELF);

		expect(p.handleFrame(addedFrame('mac'))).toBe(true);
		expect(p.list()).toEqual([{ installationId: 'mac' }]);

		expect(p.handleFrame(addedFrame('phone'))).toBe(true);
		expect(p.list()).toEqual([
			{ installationId: 'mac' },
			{ installationId: 'phone' },
		]);

		expect(p.handleFrame(removedFrame('mac'))).toBe(true);
		expect(p.list()).toEqual([{ installationId: 'phone' }]);
	});

	test('snapshot excludes self', () => {
		const p = createPresenceTracker(SELF);
		p.handleFrame(snapshotFrame([SELF, 'mac', 'phone']));
		expect(p.list()).toEqual([
			{ installationId: 'mac' },
			{ installationId: 'phone' },
		]);
	});

	test('presence_added for self is ignored', () => {
		const p = createPresenceTracker(SELF);
		expect(p.handleFrame(addedFrame(SELF))).toBe(true);
		expect(p.list()).toEqual([]);
	});

	test('list excludes self even on duplicate adds (idempotent)', () => {
		const p = createPresenceTracker(SELF);
		p.handleFrame(addedFrame('mac'));
		p.handleFrame(addedFrame('mac'));
		expect(p.list()).toEqual([{ installationId: 'mac' }]);
	});

	test('list output is sorted and deduped', () => {
		const p = createPresenceTracker(SELF);
		p.handleFrame(snapshotFrame(['phone', 'mac', 'laptop', 'mac']));
		expect(p.list()).toEqual([
			{ installationId: 'laptop' },
			{ installationId: 'mac' },
			{ installationId: 'phone' },
		]);
	});

	test('handleFrame returns false on unrecognized payloads', () => {
		const p = createPresenceTracker(SELF);
		// Not JSON.
		expect(p.handleFrame('not json')).toBe(false);
		// Wrong shape.
		expect(p.handleFrame(JSON.stringify({ hello: 'world' }))).toBe(false);
		// Unknown type.
		expect(
			p.handleFrame(JSON.stringify({ type: 'dispatch_inbound' })),
		).toBe(false);
		// presence_snapshot with non-array installs.
		expect(
			p.handleFrame(
				JSON.stringify({ type: 'presence_snapshot', installs: 'oops' }),
			),
		).toBe(false);
		// presence_added with non-string install.
		expect(
			p.handleFrame(JSON.stringify({ type: 'presence_added', install: 7 })),
		).toBe(false);
	});

	test('subscribe fires on snapshot, added, and removed', () => {
		const p = createPresenceTracker(SELF);
		const observed: string[][] = [];
		const unsub = p.subscribe((devices) => {
			observed.push(devices.map((d) => d.installationId));
		});

		p.handleFrame(snapshotFrame(['mac']));
		p.handleFrame(addedFrame('phone'));
		p.handleFrame(removedFrame('mac'));

		expect(observed).toEqual([['mac'], ['mac', 'phone'], ['phone']]);

		unsub();
		p.handleFrame(addedFrame('laptop'));
		// No new notification after unsubscribe.
		expect(observed.length).toBe(3);
	});

	test('subscribe does not fire when added does not change the set', () => {
		const p = createPresenceTracker(SELF);
		p.handleFrame(addedFrame('mac'));

		const observed: string[][] = [];
		p.subscribe((devices) => {
			observed.push(devices.map((d) => d.installationId));
		});

		// Already present, no change, no notification.
		p.handleFrame(addedFrame('mac'));
		expect(observed).toEqual([]);
	});

	test('subscribe does not fire when removed misses', () => {
		const p = createPresenceTracker(SELF);

		const observed: string[][] = [];
		p.subscribe((devices) => {
			observed.push(devices.map((d) => d.installationId));
		});

		// Remove an install that was never present: no notification.
		p.handleFrame(removedFrame('ghost'));
		expect(observed).toEqual([]);
	});

	test('reset clears the set and hasSnapshot', () => {
		const p = createPresenceTracker(SELF);
		p.handleFrame(snapshotFrame(['mac', 'phone']));
		expect(p.hasSnapshot).toBe(true);

		const observed: string[][] = [];
		p.subscribe((devices) => {
			observed.push(devices.map((d) => d.installationId));
		});

		p.reset();
		expect(p.list()).toEqual([]);
		expect(p.hasSnapshot).toBe(false);
		expect(observed).toEqual([[]]);
	});

	test('reset on an empty tracker without prior snapshot is a no-op', () => {
		const p = createPresenceTracker(SELF);
		const observed: string[][] = [];
		p.subscribe((devices) => {
			observed.push(devices.map((d) => d.installationId));
		});
		p.reset();
		expect(observed).toEqual([]);
	});
});
