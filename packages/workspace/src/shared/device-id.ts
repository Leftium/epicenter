/**
 * Per-installation deviceId — read from storage, or generate-and-persist.
 *
 * The peer dispatch layer (`peer<T>(workspace, deviceId)`) addresses peers by
 * a single string. For first-match-wins resolution to be safe, that string
 * must be cryptographically unique per installation: two browser tabs of the
 * same SPA share localStorage and so share a deviceId (they're interchangeable
 * runtimes); two physical devices have distinct deviceIds (no collision).
 *
 * `SimpleStorage` is a sync `{ getItem, setItem }` shape. Adapters land
 * alongside the storage they wrap (localStorage in apps' browser entries,
 * chrome.storage with `whenReady`-gated cache in tab-manager,
 * tauri-plugin-store wrappers in apps that need them) — same pattern as
 * auth's `SessionStore`.
 */

import { generateGuid } from './id.js';

/**
 * Sync get/set storage adapter. Conforms to localStorage out of the box;
 * async stores (chrome.storage, tauri-plugin-store) wrap with a
 * `whenReady`-gated synchronous cache.
 */
export type SimpleStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};

const KEY = 'epicenter:deviceId';

/**
 * Read the persisted deviceId, or generate-and-persist one if absent.
 * Idempotent — subsequent calls return the same value.
 */
export function getOrCreateDeviceId(storage: SimpleStorage): string {
	const existing = storage.getItem(KEY);
	if (existing) return existing;
	const fresh = generateGuid();
	storage.setItem(KEY, fresh);
	return fresh;
}
