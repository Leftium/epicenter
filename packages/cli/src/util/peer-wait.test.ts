import { describe, expect, test } from 'bun:test';
import type { AwarenessState } from '../load-config';
import { findPeer } from './peer-wait';

/**
 * Test helper — lets fixtures pass partial / malformed device shapes
 * (we're testing graceful handling of runtime data that violates the
 * schema). Production code receives `AwarenessState` already validated
 * by the awareness wrapper.
 */
function peersOf(
	rows: Array<[number, unknown]>,
): Map<number, AwarenessState> {
	return new Map(rows) as Map<number, AwarenessState>;
}

describe('findPeer — exact deviceId match, first-match-wins', () => {
	test('matches the peer publishing the deviceId', () => {
		const peers = peersOf([
			[42, { device: { id: 'macbook-pro', name: 'MacBook' } }],
			[188, { device: { id: 'iphone-15', name: 'Phone' } }],
		]);
		expect(findPeer('iphone-15', peers)).toEqual({
			kind: 'found',
			clientID: 188,
			state: { device: { id: 'iphone-15', name: 'Phone' } } as AwarenessState,
		});
	});

	test('first match wins on duplicate deviceIds (clientID-ascending)', () => {
		const peers = peersOf([
			[200, { device: { id: 'shared' } }],
			[50, { device: { id: 'shared' } }],
			[100, { device: { id: 'shared' } }],
		]);
		const result = findPeer('shared', peers);
		expect(result.kind).toBe('found');
		if (result.kind === 'found') expect(result.clientID).toBe(50);
	});

	test('returns not-found when no peer publishes the deviceId', () => {
		const peers = peersOf([[42, { device: { id: 'macbook-pro' } }]]);
		expect(findPeer('ghost', peers)).toEqual({ kind: 'not-found' });
	});

	test('returns not-found when peers have no device field at all', () => {
		const peers = peersOf([[42, { something: 'else' }]]);
		expect(findPeer('macbook-pro', peers)).toEqual({ kind: 'not-found' });
	});

	test('returns not-found when device field is malformed', () => {
		const peers = peersOf([
			[42, { device: 'not-an-object' as unknown as Record<string, unknown> }],
			[100, { device: { name: 'no-id-here' } }],
		]);
		expect(findPeer('macbook-pro', peers)).toEqual({ kind: 'not-found' });
	});
});
