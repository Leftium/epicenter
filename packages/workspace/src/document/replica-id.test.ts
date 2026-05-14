import { describe, expect, it } from 'bun:test';
import {
	type AsyncStorage,
	createReplicaId,
	createReplicaIdAsync,
	type SimpleStorage,
} from './replica-id.js';

function makeMemoryStorage(
	initial: Record<string, string> = {},
): SimpleStorage {
	const store = new Map(Object.entries(initial));
	return {
		getItem: (k) => store.get(k) ?? null,
		setItem: (k, v) => {
			store.set(k, v);
		},
	};
}

function makeAsyncMemoryStorage(
	initial: Record<string, string> = {},
): AsyncStorage {
	const store = new Map(Object.entries(initial));
	return {
		getItem: async (k) => store.get(k) ?? null,
		setItem: async (k, v) => {
			store.set(k, v);
		},
	};
}

describe('createReplicaId', () => {
	it('returns the existing value when storage already holds one', () => {
		const storage = makeMemoryStorage({
			'epicenter.installation.id': 'preexisting-id',
		});
		expect(createReplicaId({ storage })).toBe('preexisting-id');
	});

	it('generates and persists when storage is empty', () => {
		const storage = makeMemoryStorage();
		const fresh = createReplicaId({ storage });
		expect(fresh).toMatch(/^[a-z0-9]{15}$/);
		expect(storage.getItem('epicenter.installation.id')).toBe(fresh);
	});

	it('returns the same value on subsequent calls (idempotent)', () => {
		const storage = makeMemoryStorage();
		const first = createReplicaId({ storage });
		const second = createReplicaId({ storage });
		expect(second).toBe(first);
	});

	it('does not collide on independent storages', () => {
		const a = createReplicaId({ storage: makeMemoryStorage() });
		const b = createReplicaId({ storage: makeMemoryStorage() });
		expect(a).not.toBe(b);
	});
});

describe('createReplicaIdAsync', () => {
	it('returns the existing value when storage already holds one', async () => {
		const storage = makeAsyncMemoryStorage({
			'epicenter.installation.id': 'preexisting-id',
		});
		expect(await createReplicaIdAsync({ storage })).toBe('preexisting-id');
	});

	it('generates and persists when storage is empty', async () => {
		const storage = makeAsyncMemoryStorage();
		const fresh = await createReplicaIdAsync({ storage });
		expect(fresh).toMatch(/^[a-z0-9]{15}$/);
		expect(await storage.getItem('epicenter.installation.id')).toBe(fresh);
	});

	it('returns the same value on subsequent calls (idempotent)', async () => {
		const storage = makeAsyncMemoryStorage();
		const first = await createReplicaIdAsync({ storage });
		const second = await createReplicaIdAsync({ storage });
		expect(second).toBe(first);
	});
});
