/**
 * Server URL for the tab manager extension.
 *
 * Single reactive URL backed by chrome.storage.local. Defaults to the
 * production API (`https://api.epicenter.so`). All services — sync,
 * auth, AI, billing — share one origin.
 *
 * Not user-configurable. Developers can override via devtools or
 * chrome.storage.local for local development / self-hosted testing.
 * Changing the URL requires an extension context reload.
 *
 * @example
 * ```typescript
 * import { serverUrl } from '$lib/state/settings.svelte';
 *
 * serverUrl.current   // 'https://api.epicenter.so'
 * serverUrl.current = 'http://localhost:3913';  // dev override
 * ```
 */

import { APP_URLS } from '@epicenter/constants/vite';
import { type } from 'arktype';
import { createStorageState } from './storage-state.svelte';

/** Reactive server URL (sync, auth, AI, billing). */
export const serverUrl = createStorageState('local:serverUrl', {
	fallback: APP_URLS.API,
	schema: type('string'),
});
