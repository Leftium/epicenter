/**
 * opensidian's device-local inference connection registry (ADR-0059).
 *
 * One shared registry (built once here) that the chat input picker, the engine,
 * and the cross-device banner all read. Hosted is opensidian's curated catalog
 * (`APP_MODELS`); custom connections and their discovered models live in
 * localStorage, never synced (a key is a secret and a `localhost` URL is
 * meaningless elsewhere, ADR-0004).
 */

import { createInferenceConnections } from '@epicenter/app-shell/inference-picker';
import { toHostedCatalog } from '@epicenter/constants/ai-providers';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { APP_MODELS } from '$lib/chat/models';
import { auth } from '$platform/auth';

export const inferenceConnections = createInferenceConnections({
	storageKey: 'opensidian',
	hostedModels: toHostedCatalog(APP_MODELS),
	hosted: {
		fetch: auth.fetch,
		baseURL: API_ROUTES.ai.completions.baseUrl(APP_URLS.API),
	},
	persist: (key, schema, defaultValue) =>
		createPersistedState({ key, schema, defaultValue }),
});
