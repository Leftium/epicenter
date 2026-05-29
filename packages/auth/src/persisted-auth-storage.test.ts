import { describe, expect, test } from 'bun:test';
import { createWebStoragePersistedAuthStorage } from './persisted-auth-storage.js';

describe('createWebStoragePersistedAuthStorage', () => {
	test('treats a corrupt cell as signed out', () => {
		const storage = new MemoryStorage();
		storage.setItem('auth', '{');

		const persistedAuthStorage = createWebStoragePersistedAuthStorage({
			key: 'auth',
			storage,
		});

		expect(persistedAuthStorage.get()).toBeNull();
	});

	test('treats a missing cell as signed out', () => {
		const persistedAuthStorage = createWebStoragePersistedAuthStorage({
			key: 'auth',
			storage: new MemoryStorage(),
		});

		expect(persistedAuthStorage.get()).toBeNull();
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
