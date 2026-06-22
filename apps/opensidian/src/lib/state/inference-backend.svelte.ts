/**
 * The device-local inference backend (ADR-0053).
 *
 * opensidian's conversations sync, but which server answers chat is a
 * device-scoped choice: a `localhost` URL means nothing on another device and an
 * API key must not ride the relay (ADR-0004). So the backend lives in localStorage
 * (`createPersistedState`), never the synced workspace. The chat state reads it
 * inside the engine's per-turn thunk, so a switch takes effect on the next turn.
 */

import type { InferenceBackendConfig } from '@epicenter/client';
import { createPersistedState } from '@epicenter/svelte';
import { type } from 'arktype';

const inferenceBackendSchema = type({ mode: "'hosted'" }).or({
	mode: "'custom'",
	baseUrl: 'string',
	model: 'string',
	'apiKey?': 'string',
});

export const inferenceBackend = createPersistedState({
	key: 'opensidian.inference-backend',
	schema: inferenceBackendSchema,
	defaultValue: { mode: 'hosted' } satisfies InferenceBackendConfig,
});
