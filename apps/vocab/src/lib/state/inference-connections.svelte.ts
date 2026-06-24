/**
 * Vocab's device-local inference connection registry (ADR-0059).
 *
 * One shared registry (built once here) that the header picker, the engine, and
 * the cross-device banner all read. Hosted is Vocab's one curated model
 * (`VOCAB_MODEL`); custom connections and their discovered models live in
 * localStorage, never synced (a key is a secret and a `localhost` URL is
 * meaningless elsewhere, ADR-0004).
 */

import { createInferenceConnections } from '@epicenter/app-shell/inference-picker';
import { MODELS_BY_ID } from '@epicenter/constants/ai-providers';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { VOCAB_MODEL } from '@epicenter/vocab';
import { auth } from '$platform/auth';

export const inferenceConnections = createInferenceConnections({
	storageKey: 'vocab',
	hostedModels: [
		{
			id: VOCAB_MODEL,
			label: MODELS_BY_ID[VOCAB_MODEL].label,
			credits: MODELS_BY_ID[VOCAB_MODEL].credits,
		},
	],
	hosted: {
		fetch: auth.fetch,
		baseURL: API_ROUTES.ai.completions.baseUrl(APP_URLS.API),
	},
	persist: (key, schema, defaultValue) =>
		createPersistedState({ key, schema, defaultValue }),
});
