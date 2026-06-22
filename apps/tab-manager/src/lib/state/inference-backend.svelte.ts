/**
 * The device-local inference backend (ADR-0054).
 *
 * Which server answers chat is a device-scoped choice: the metered Epicenter
 * gateway, or a custom OpenAI-compatible URL (a local Ollama, a self-hosted
 * gateway, OpenRouter). It lives in `chrome.storage.local`, the same device-local
 * channel every other tab-manager preference uses, and never the synced
 * workspace: a `localhost` URL means nothing on another device, and an API key is
 * a secret that must not ride the relay.
 *
 * The chat state reads `inferenceBackend.get()` inside the engine's per-turn
 * thunk, so switching the backend takes effect on the next turn.
 */

import type { InferenceBackendConfig } from '@epicenter/client';
import { type } from 'arktype';
import { createStorageState } from './storage-state.svelte';

const inferenceBackendSchema = type({ mode: "'hosted'" }).or({
	mode: "'custom'",
	baseUrl: 'string',
	model: 'string',
	'apiKey?': 'string',
});

export const inferenceBackend = createStorageState('local:inference.backend', {
	fallback: { mode: 'hosted' } satisfies InferenceBackendConfig,
	schema: inferenceBackendSchema,
});
