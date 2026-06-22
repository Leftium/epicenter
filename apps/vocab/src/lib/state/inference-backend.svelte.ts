/**
 * The device-local inference backend (ADR-0054).
 *
 * Which server answers is a device-scoped choice: the metered Epicenter gateway,
 * or a custom OpenAI-compatible URL (a local Ollama, your own gateway). It lives
 * in localStorage, never the synced workspace: a `localhost` URL means nothing on
 * another device and an API key must not ride the relay (ADR-0004). The engine
 * reads it per turn, so a switch takes effect on the next turn.
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
	key: 'vocab.inference-backend',
	schema: inferenceBackendSchema,
	defaultValue: { mode: 'hosted' } satisfies InferenceBackendConfig,
});
