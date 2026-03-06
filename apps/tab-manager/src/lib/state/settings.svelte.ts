/**
 * Server URL settings for the tab manager extension.
 *
 * Two reactive URLs are maintained, backed by chrome.storage.local:
 * - **serverUrl**: Local server for sync and workspace operations.
 * - **remoteServerUrl**: Remote server for AI, auth, and key management.
 *
 * Both default to `https://api.epicenter.so`. For multi-server deployments,
 * set remoteServerUrl to the remote server's public address.
 *
 * @example
 * ```typescript
 * import { serverUrl, remoteServerUrl } from '$lib/state/settings.svelte';
 *
 * // Read reactively in templates or $derived:
 * serverUrl.current   // 'https://api.epicenter.so'
 *
 * // Write (optimistic — UI updates immediately, persists async):
 * serverUrl.current = 'http://localhost:3913';
 * ```
 */

import { type } from 'arktype';
import { createStorageState } from './storage-state.svelte';

const DEFAULT_SERVER_URL = 'https://api.epicenter.so';

/** Reactive local server URL. */
export const serverUrl = createStorageState('local:serverUrl', {
	fallback: DEFAULT_SERVER_URL,
	schema: type('string'),
});

/** Reactive remote server URL (AI, auth, keys). */
export const remoteServerUrl = createStorageState('local:remoteServerUrl', {
	fallback: DEFAULT_SERVER_URL,
	schema: type('string'),
});
