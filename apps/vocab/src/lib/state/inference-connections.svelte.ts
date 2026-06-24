/**
 * The device-local inference connections (ADR-0058).
 *
 * The device holds a set of custom OpenAI-compatible connections (the built-in
 * hosted Epicenter gateway is implicit) plus a cache of the model ids each one
 * was discovered to serve. Both live in localStorage, never the synced workspace:
 * a `localhost` URL means nothing on another device and an API key must not ride
 * the relay (ADR-0004). The engine and the picker read them per use, so a change
 * takes effect on the next turn.
 */

import { createPersistedState } from '@epicenter/svelte';
import { type } from 'arktype';

const customConnectionSchema = type({
	kind: "'custom'",
	'preset?': "'ollama' | 'lmstudio' | 'openai' | 'openrouter' | 'groq'",
	baseUrl: 'string',
	'apiKey?': 'string',
});

/** The device's custom connections, in display order. */
export const inferenceConnections = createPersistedState({
	key: 'vocab.inference-connections',
	schema: customConnectionSchema.array(),
	defaultValue: [],
});

/**
 * Model ids discovered per connection, keyed by base URL. Survives a reopen and
 * feeds `resolveForModel`, so a synced conversation's custom model resolves to the
 * connection that serves it without a re-fetch.
 */
export const discoveredModels = createPersistedState({
	key: 'vocab.discovered-models',
	schema: type({ '[string]': 'string[]' }),
	defaultValue: {},
});
