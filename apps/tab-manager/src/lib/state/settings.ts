/**
 * Server URL settings for the tab manager extension.
 *
 * Two URLs are maintained:
 * - **Server URL** (`serverUrl`): The local server for sync and workspace
 *   operations. Defaults to `http://127.0.0.1:3913`.
 * - **Hub Server URL** (`hubServerUrl`): The hub server for AI, auth, and key
 *   management. Defaults to the same address — in single-server setups both
 *   point to the same place. For multi-server deployments, set this to the
 *   hub's address (e.g., `https://hub.epicenter.so`).
 *
 * @example
 * ```typescript
 * const serverUrl = await getServerUrl();
 * const hubUrl = await getHubServerUrl();
 * ```
 */

import { storage } from '@wxt-dev/storage';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3913';

/**
 * Local server URL storage item.
 *
 * Points to the local server for sync and workspace operations.
 * Defaults to localhost — the standard self-hosted server address.
 * Persisted in chrome.storage.local so it survives browser restarts.
 */
const serverUrlItem = storage.defineItem<string>('local:serverUrl', {
	fallback: DEFAULT_SERVER_URL,
});

/**
 * Hub server URL storage item.
 *
 * Points to the hub server for AI completions, authentication, and
 * API key management. Defaults to the same localhost address as the
 * local server — in single-server setups both URLs are identical.
 *
 * For multi-server deployments (e.g., Epicenter Cloud), set this to
 * the hub's public address.
 */
const hubServerUrlItem = storage.defineItem<string>('local:hubServerUrl', {
	fallback: DEFAULT_SERVER_URL,
});

/**
 * Get the local server URL from chrome.storage.
 *
 * Returns the persisted URL, or the default `http://127.0.0.1:3913`
 * if none has been set.
 *
 * @example
 * ```typescript
 * const url = await getServerUrl();
 * fetch(`${url}/api/sync`);
 * ```
 */
export async function getServerUrl() {
	return serverUrlItem.getValue();
}

/**
 * Get the hub server URL from chrome.storage.
 *
 * Returns the persisted URL, or the default `http://127.0.0.1:3913`
 * if none has been set. The hub server handles AI completions,
 * authentication, and API key management.
 *
 * @example
 * ```typescript
 * const hubUrl = await getHubServerUrl();
 * fetch(`${hubUrl}/api/chat`);
 * ```
 */
export async function getHubServerUrl() {
	return hubServerUrlItem.getValue();
}
