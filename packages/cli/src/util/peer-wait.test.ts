import { describe, expect, test } from 'bun:test';
import type { AwarenessState } from '../load-config';
import { findPeer } from './peer-wait';

const fakeDevice = (
	overrides: Partial<AwarenessState['device']> = {},
): AwarenessState => ({
	device: {
		id: 'mac-1',
		name: 'MacBook',
		platform: 'tauri',
		...overrides,
	},
});

describe('findPeer — exact deviceId match, first-match-wins', () => {
	test('matches the peer publishing the deviceId', () => {
		const peers = new Map<number, AwarenessState>([
			[42, fakeDevice({ id: 'macbook-pro' })],
			[188, fakeDevice({ id: 'iphone-15', name: 'Phone' })],
		]);
		const result = findPeer('iphone-15', peers);
		expect(result).not.toBeNull();
		expect(result?.clientID).toBe(188);
		expect(result?.state.device.id).toBe('iphone-15');
	});

	test('first match wins on duplicate deviceIds (clientID-ascending)', () => {
		const peers = new Map<number, AwarenessState>([
			[200, fakeDevice({ id: 'shared' })],
			[50, fakeDevice({ id: 'shared' })],
			[100, fakeDevice({ id: 'shared' })],
		]);
		const result = findPeer('shared', peers);
		expect(result?.clientID).toBe(50);
	});

	test('returns null when no peer publishes the deviceId', () => {
		const peers = new Map<number, AwarenessState>([
			[42, fakeDevice({ id: 'macbook-pro' })],
		]);
		expect(findPeer('ghost', peers)).toBeNull();
	});
});
