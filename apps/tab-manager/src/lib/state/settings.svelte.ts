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

import { storage } from '@wxt-dev/storage';
import { createExtensionState } from './extension-state.svelte';

const DEFAULT_SERVER_URL = 'https://api.epicenter.so';

const serverUrlItem = storage.defineItem<string>('local:serverUrl', {
	fallback: DEFAULT_SERVER_URL,
});

const remoteServerUrlItem = storage.defineItem<string>(
	'local:remoteServerUrl',
	{ fallback: DEFAULT_SERVER_URL },
);

/** Reactive local server URL. */
export const serverUrl = createExtensionState(serverUrlItem);

/** Reactive remote server URL (AI, auth, keys). */
export const remoteServerUrl = createExtensionState(remoteServerUrlItem);
