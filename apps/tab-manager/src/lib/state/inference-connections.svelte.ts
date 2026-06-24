/**
 * tab-manager's device-local inference connection registry (ADR-0058).
 *
 * One shared registry (built once here) that the chat input picker, the engine,
 * and the cross-device banner all read. Hosted is tab-manager's curated catalog
 * (`APP_MODELS`); custom connections and their discovered models live in
 * `chrome.storage.local` (the `createStorageState` adapter), never synced (a key
 * is a secret and a `localhost` URL is meaningless elsewhere, ADR-0004).
 */

import { createInferenceConnections } from '@epicenter/app-shell/inference-picker';
import { MODELS_BY_ID } from '@epicenter/constants/ai-providers';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { APP_URLS } from '@epicenter/constants/vite';
import type { StorageItemKey } from '@wxt-dev/storage';
import { APP_MODELS } from '$lib/chat/models';
import { tabManagerSession } from '$lib/session.svelte';
import { createStorageState } from './storage-state.svelte';

export const inferenceConnections = createInferenceConnections({
	storageKey: 'tab-manager',
	hostedModels: APP_MODELS.map((id) => ({
		id,
		label: MODELS_BY_ID[id].label,
		credits: MODELS_BY_ID[id].credits,
	})),
	hosted: {
		// The extension's auth client is deferred-init (it throws before storage
		// readiness), so read it at turn time inside this closure, never at module
		// load. The hosted transport is only resolved when a hosted turn generates.
		fetch: (input, init) => tabManagerSession.auth.fetch(input, init),
		baseURL: API_ROUTES.ai.completions.baseUrl(APP_URLS.API),
	},
	persist: (key, schema, fallback) =>
		createStorageState(`local:${key}` as StorageItemKey, { schema, fallback }),
});
