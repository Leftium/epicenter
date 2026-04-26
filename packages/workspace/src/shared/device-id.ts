/**
 * Per-installation deviceId — read from storage, or generate-and-persist.
 *
 * The peer dispatch layer (`peer<T>(workspace, deviceId)`) addresses peers by
 * a single string. For first-match-wins resolution to be safe, that string
 * must be cryptographically unique per installation: two browser tabs of the
 * same SPA share localStorage and so share a deviceId (they're interchangeable
 * runtimes); two physical devices have distinct deviceIds (no collision).
 *
 * Two adapter shapes — pick the one matching your storage:
 *   - `SimpleStorage` (sync): localStorage, in-memory.
 *   - `AsyncStorage`         : chrome.storage, tauri-plugin-store, IDB-backed.
 *
 * Resolve once at boot (in your app's `client.ts`) and pass the id straight
 * into the workspace factory's `device` arg — don't paper over async with a
 * sync facade.
 */

import { generateGuid } from './id.js';

export type SimpleStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};

export type AsyncStorage = {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
};

const KEY = 'epicenter:deviceId';

/**
 * Read the persisted deviceId from a sync store, or generate-and-persist one
 * if absent. Idempotent — subsequent calls return the same value.
 */
export function getOrCreateDeviceId(storage: SimpleStorage): string {
	const existing = storage.getItem(KEY);
	if (existing) return existing;
	const fresh = generateGuid();
	storage.setItem(KEY, fresh);
	return fresh;
}

/**
 * Async variant for stores that don't expose a sync read (chrome.storage,
 * tauri-plugin-store). Resolve once at boot and treat the result as a plain
 * string — don't await it on every call.
 */
export async function getOrCreateDeviceIdAsync(
	storage: AsyncStorage,
): Promise<string> {
	const existing = await storage.getItem(KEY);
	if (existing) return existing;
	const fresh = generateGuid();
	await storage.setItem(KEY, fresh);
	return fresh;
}
