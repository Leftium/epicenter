/**
 * The inference-backend setting and its resolver (ADR-0054). A chat app stores
 * one {@link InferenceBackendConfig} per device and resolves it, per turn, to the
 * {@link ResolvedInferenceBackend} the OpenAI-compatible engine drives.
 *
 * The leak guard is structural. The app passes its Epicenter transport (the authed
 * fetch carrying the bearer) on every turn, but the resolver returns it only on the
 * `hosted` branch; custom mode discards it and mints a plain fetch carrying only the
 * user's own key, so a custom turn can never reach its URL with the Epicenter
 * bearer. The bearer is in any case audience-scoped to its origin (ADR-0053), so
 * even a wiring mistake cannot send it to a custom URL.
 */

import type { EngineFetch } from './agent-engine.js';

/**
 * A chat app's inference backend, stored device-local (ADR-0054). `hosted` is the
 * metered Epicenter gateway, whose model is the app's curated catalog. `custom` is
 * any OpenAI-compatible server (a local Ollama, a self-hosted gateway, OpenRouter)
 * reached by `baseUrl`, serving the free-text `model` it was given, with an
 * optional Bearer key. A local backend needs no key, so `apiKey` is optional. The
 * model rides with the backend so the two can never mismatch (a hosted catalog id
 * is meaningless to Ollama, and vice versa).
 */
export type InferenceBackendConfig =
	| { mode: 'hosted' }
	| { mode: 'custom'; baseUrl: string; model: string; apiKey?: string };

/**
 * What the engine drives for one turn: the transport (`fetch` + `baseURL`) and the
 * `model` to call. A custom config carries all three itself; the `hosted` argument
 * to {@link resolveInferenceBackend} supplies them for the hosted case.
 */
export type ResolvedInferenceBackend = {
	fetch: EngineFetch;
	baseURL: string;
	model: string;
};

/**
 * Resolve a backend config to the `{ fetch, baseURL, model }` the engine drives.
 *
 * Hosted returns the supplied Epicenter backend unchanged. Custom builds its own:
 * its `baseUrl` and `model`, plus a plain fetch (never the Epicenter bearer) that
 * attaches the user's key as a Bearer when they gave one; a keyless local backend
 * gets a bare fetch. The model rides with the backend, so the caller never re-pairs
 * a model with a transport.
 */
export function resolveInferenceBackend(
	config: InferenceBackendConfig,
	hosted: ResolvedInferenceBackend,
): ResolvedInferenceBackend {
	if (config.mode === 'hosted') return hosted;
	const apiKey = config.apiKey?.trim();
	const fetch: EngineFetch = apiKey
		? (input, init) => {
				const headers = new Headers(init?.headers);
				headers.set('Authorization', `Bearer ${apiKey}`);
				return globalThis.fetch(input, { ...init, headers });
			}
		: globalThis.fetch.bind(globalThis);
	return { fetch, baseURL: config.baseUrl, model: config.model };
}
