import { describe, expect, test } from 'bun:test';
import { PersistedAuth } from './auth-types.js';
import {
	type AsyncAuthCellStore,
	createWebStoragePersistedAuthStorage,
	loadPersistedAuthStorage,
	serializePersistedAuthCell,
} from './persisted-auth-storage.js';

const cell = PersistedAuth.assert({
	grant: {
		accessToken: 'access',
		refreshToken: 'refresh',
		accessTokenExpiresAt: 1_000_000,
	},
	userId: 'user-1',
	ownerId: 'user-1',
	keyring: [
		{
			version: 1,
			keyBytesBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
	],
});

describe('createWebStoragePersistedAuthStorage', () => {
	test('treats a corrupt cell as signed out', () => {
		const storage = new MemoryStorage();
		storage.setItem('auth', '{');

		const persistedAuthStorage = createWebStoragePersistedAuthStorage({
			key: 'auth',
			storage,
		});

		expect(persistedAuthStorage.initial).toBeNull();
	});

	test('treats a missing cell as signed out', () => {
		const persistedAuthStorage = createWebStoragePersistedAuthStorage({
			key: 'auth',
			storage: new MemoryStorage(),
		});

		expect(persistedAuthStorage.initial).toBeNull();
	});

	test('set(null) removes the key', () => {
		const storage = new MemoryStorage();
		storage.setItem('auth', 'whatever');

		const persistedAuthStorage = createWebStoragePersistedAuthStorage({
			key: 'auth',
			storage,
		});
		persistedAuthStorage.set(null);

		expect(storage.getItem('auth')).toBeNull();
	});
});

describe('loadPersistedAuthStorage', () => {
	function trackingStore(initial: string | null): AsyncAuthCellStore & {
		written: Array<string | null>;
	} {
		let current = initial;
		const written: Array<string | null> = [];
		return {
			written,
			read: () => Promise.resolve(current),
			write: (serialized) => {
				written.push(serialized);
				current = serialized;
				return Promise.resolve();
			},
		};
	}

	test('hydrates initial from the async read', async () => {
		const store = trackingStore(serializePersistedAuthCell(cell));

		const persistedAuthStorage = await loadPersistedAuthStorage(store);

		expect(persistedAuthStorage.initial).toEqual(cell);
	});

	test('a corrupt async cell hydrates as signed out', async () => {
		const persistedAuthStorage = await loadPersistedAuthStorage(
			trackingStore('{'),
		);

		expect(persistedAuthStorage.initial).toBeNull();
	});

	test('set forwards a serialized write to the store', async () => {
		const store = trackingStore(null);
		const persistedAuthStorage = await loadPersistedAuthStorage(store);

		await persistedAuthStorage.set(cell);

		expect(store.written).toEqual([serializePersistedAuthCell(cell)]);
	});

	test('set(null) forwards a remove to the store', async () => {
		const store = trackingStore(serializePersistedAuthCell(cell));
		const persistedAuthStorage = await loadPersistedAuthStorage(store);

		await persistedAuthStorage.set(null);

		expect(store.written).toEqual([null]);
	});
});

class MemoryStorage implements Storage {
	readonly #items = new Map<string, string>();

	get length(): number {
		return this.#items.size;
	}

	clear(): void {
		this.#items.clear();
	}

	getItem(key: string): string | null {
		return this.#items.get(key) ?? null;
	}

	key(index: number): string | null {
		return [...this.#items.keys()][index] ?? null;
	}

	removeItem(key: string): void {
		this.#items.delete(key);
	}

	setItem(key: string, value: string): void {
		this.#items.set(key, value);
	}
}
