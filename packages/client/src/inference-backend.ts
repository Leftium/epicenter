/**
 * The inference-backend setting and its resolver (ADR-0053). A chat app stores
 * one {@link InferenceBackendConfig} per device and resolves it, per turn, to the
 * {@link ResolvedInferenceBackend} the OpenAI-compatible engine drives.
 *
 * The leak guard is structural. A custom backend carries no fetch, so an app can
 * never hand the resolver the Epicenter bearer; the resolver references the hosted
 * (Epicenter) fetch in exactly one branch, paired with the Epicenter base URL.
 * Custom mode mints a plain fetch and attaches only the user's own key. The
 * Epicenter bearer is in any case audience-scoped to its origin (ADR-0052), so
 * even a wiring mistake cannot send it to a custom URL.
 */

import type { EngineFetch } from './agent-engine.js';

/**
 * A chat app's inference backend, stored device-local (ADR-0053). `hosted` is the
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

/** The transport the engine uses for one turn: a fetch paired with a base URL. */
export type ResolvedInferenceBackend = {
	fetch: EngineFetch;
	baseURL: string;
};

/**
 * The hosted (Epicenter) transport the app supplies: its authed fetch and the
 * gateway base URL. Used only in the `hosted` branch.
 */
export type HostedInferenceBackend = {
	fetch: EngineFetch;
	baseURL: string;
};

/**
 * Resolve a backend config to the `{ fetch, baseURL }` the engine drives.
 *
 * Hosted returns the Epicenter transport unchanged. Custom returns a plain fetch,
 * never the Epicenter bearer, that attaches the user's key as a Bearer when they
 * gave one; a keyless local backend gets a bare fetch.
 */
export function resolveInferenceBackend(
	config: InferenceBackendConfig,
	hosted: HostedInferenceBackend,
): ResolvedInferenceBackend {
	if (config.mode === 'hosted') {
		return { fetch: hosted.fetch, baseURL: hosted.baseURL };
	}
	const apiKey = config.apiKey?.trim();
	const fetch: EngineFetch = apiKey
		? (input, init) => {
				const headers = new Headers(init?.headers);
				headers.set('Authorization', `Bearer ${apiKey}`);
				return globalThis.fetch(input, { ...init, headers });
			}
		: globalThis.fetch.bind(globalThis);
	return { fetch, baseURL: config.baseUrl };
}
