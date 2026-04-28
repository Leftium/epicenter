import { describe, expect, it } from 'bun:test';
import { getOrCreateDeviceId, type SimpleStorage } from './device-id.js';

function makeMemoryStorage(initial: Record<string, string> = {}): SimpleStorage {
	const store = new Map(Object.entries(initial));
	return {
		getItem: (k) => store.get(k) ?? null,
		setItem: (k, v) => {
			store.set(k, v);
		},
	};
}

describe('getOrCreateDeviceId', () => {
	it('returns the existing value when storage already holds one', () => {
		const storage = makeMemoryStorage({ 'epicenter:deviceId': 'preexisting-id' });
		expect(getOrCreateDeviceId(storage)).toBe('preexisting-id');
	});

	it('generates and persists when storage is empty', () => {
		const storage = makeMemoryStorage();
		const fresh = getOrCreateDeviceId(storage);
		expect(fresh).toMatch(/^[a-z0-9]{15}$/);
		expect(storage.getItem('epicenter:deviceId')).toBe(fresh);
	});

	it('returns the same value on subsequent calls (idempotent)', () => {
		const storage = makeMemoryStorage();
		const first = getOrCreateDeviceId(storage);
		const second = getOrCreateDeviceId(storage);
		expect(second).toBe(first);
	});

	it('does not collide on independent storages', () => {
		const a = getOrCreateDeviceId(makeMemoryStorage());
		const b = getOrCreateDeviceId(makeMemoryStorage());
		expect(a).not.toBe(b);
	});
});
