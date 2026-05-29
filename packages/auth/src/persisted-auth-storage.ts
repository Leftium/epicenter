import { PersistedAuth } from './auth-types.js';

/**
 * Storage adapter for the single `PersistedAuth` cell (grant + identity + keyring).
 * Two methods, no watch hook: cross-context sign-out propagates via the
 * server (next bearer-bearing call hits a revoked token and reauth-requires
 * organically). The server is the authority; brief cross-tab desync is
 * acceptable.
 *
 * `get` is synchronous because the auth runtime reads it exactly once, at
 * construction, to seed its state machine. Runtimes whose store is async
 * (an extension's `chrome.storage`, a file) pre-load through
 * {@link loadPersistedAuthStorage} so this read stays synchronous.
 */
export type PersistedAuthStorage = {
	get(): PersistedAuth | null;
	set(value: PersistedAuth | null): void | Promise<void>;
};

/**
 * Decode a stored cell string into a `PersistedAuth`, or `null` when the cell
 * is absent, not JSON, or fails schema validation. The single owner of the
 * "corrupt or legacy cell reads as signed out" rule, shared by every storage
 * adapter whose substrate frames the cell as a string.
 */
export function parsePersistedAuthCell(raw: string | null): PersistedAuth | null {
	if (raw === null) return null;
	try {
		return PersistedAuth.assert(JSON.parse(raw));
	} catch {
		return null;
	}
}

/**
 * Encode a cell for storage. Re-validates before writing so an unvalidated
 * value can never reach durable storage.
 */
export function serializePersistedAuthCell(value: PersistedAuth): string {
	return JSON.stringify(PersistedAuth.assert(value));
}

/**
 * Build a {@link PersistedAuthStorage} over a synchronous Web `Storage`
 * (`localStorage` or `sessionStorage`, in a browser tab or a Tauri webview).
 *
 * `get` returns `null` on a missing, non-JSON, or schema-invalid cell, so a
 * corrupt cell reads as signed-out instead of throwing. `set(null)` removes
 * the key. Write failures (`QuotaExceededError`, or `setItem` throwing in
 * private-mode Safari) are intentionally propagated rather than swallowed: a
 * credential that could not be persisted must fail the sign-in or refresh that
 * produced it, not silently look saved.
 *
 * `storage` is required, matching the OAuth launcher call sites that already
 * pass `window.localStorage` / `window.sessionStorage` explicitly. Keeping the
 * dependency explicit stops this framework-agnostic helper from reaching for a
 * `window` global of its own, which would also break under SSR import.
 */
export function createWebStoragePersistedAuthStorage({
	key,
	storage,
}: {
	key: string;
	storage: Storage;
}): PersistedAuthStorage {
	return {
		get() {
			return parsePersistedAuthCell(storage.getItem(key));
		},
		set(value) {
			if (value === null) {
				storage.removeItem(key);
				return;
			}
			storage.setItem(key, serializePersistedAuthCell(value));
		},
	};
}
