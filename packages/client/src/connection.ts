/**
 * The inference connection: a device-local, capability-orthogonal endpoint
 * (ADR-0058, amending ADR-0054). A connection is an OpenAI-compatible server plus
 * an optional key; it carries no model and no capability, so one connection can
 * drive chat, transcription, or embeddings alike. The model is the conversation's
 * (ADR-0055), paired with the transport by the caller per turn.
 *
 * The leak guard is structural and identical to ADR-0054's resolver: the app
 * passes its Epicenter transport (the authed fetch carrying the bearer) every
 * turn, but {@link resolveConnection} returns it only on the `hosted` connection;
 * a custom connection mints a plain fetch carrying only the user's key, so a
 * custom turn can never reach its URL with the Epicenter bearer (and ADR-0053
 * audience-scopes the bearer anyway).
 *
 * This module is the additive new path; the legacy {@link InferenceBackendConfig}
 * in `./inference-backend.ts` stays until its consumers migrate, then is deleted.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { EngineFetch } from './agent-engine.js';

/** A canonical OpenAI-compatible provider we pre-fill as a preset (ADR-0058). */
export type PresetId = 'ollama' | 'lmstudio' | 'openai' | 'openrouter' | 'groq';

/**
 * The data that distinguishes one OpenAI-compatible provider from another. The
 * key is always `Authorization: Bearer`, so a preset is pure data with no
 * matching code path: only the base URL and whether a key is needed differ. The
 * local-vs-cloud facet is derived from the base URL (is it `localhost`?), not
 * stored, so it cannot drift from the URL and a user-entered custom URL gets the
 * same treatment as a preset.
 */
export type ConnectionPreset = {
	id: PresetId;
	label: string;
	/** The base URL with `/v1` included, so the user never appends it. */
	baseUrl: string;
	/** Whether the endpoint needs a Bearer key; local servers do not. */
	requiresKey: boolean;
};

/**
 * The shipped presets (ADR-0058). Anthropic (its compat layer is "for testing"
 * and loses prompt caching and thinking) and a bring-your-own Gemini (its compat
 * layer 400s on tools and JSON together, which the agent loops use) are
 * deliberately absent; both are reachable as a raw custom URL. Self-hosted
 * Epicenter is also a raw custom URL, not a preset.
 */
export const CONNECTION_PRESETS = [
	{
		id: 'ollama',
		label: 'Ollama',
		baseUrl: 'http://localhost:11434/v1',
		requiresKey: false,
	},
	{
		id: 'lmstudio',
		label: 'LM Studio',
		baseUrl: 'http://localhost:1234/v1',
		requiresKey: false,
	},
	{
		id: 'openai',
		label: 'OpenAI',
		baseUrl: 'https://api.openai.com/v1',
		requiresKey: true,
	},
	{
		id: 'openrouter',
		label: 'OpenRouter',
		baseUrl: 'https://openrouter.ai/api/v1',
		requiresKey: true,
	},
	{
		id: 'groq',
		label: 'Groq',
		baseUrl: 'https://api.groq.com/openai/v1',
		requiresKey: true,
	},
] as const satisfies readonly ConnectionPreset[];

/**
 * A device-local inference connection (ADR-0058). `hosted` is the built-in
 * metered Epicenter connection; `custom` is any OpenAI-compatible URL, optionally
 * seeded from a preset, with an optional Bearer key. The device holds a set of
 * these (the built-in hosted plus zero or more custom); the conversation's model
 * selects which one serves a turn (see {@link resolveForModel}).
 */
export type Connection =
	| { kind: 'hosted' }
	| { kind: 'custom'; preset?: PresetId; baseUrl: string; apiKey?: string };

/** What one turn drives: the transport only. The model is paired by the caller. */
export type ResolvedConnection = {
	fetch: EngineFetch;
	baseURL: string;
};

/**
 * Resolve a connection to its transport. Hosted returns the supplied Epicenter
 * transport unchanged. Custom builds a plain fetch (never the Epicenter bearer)
 * that attaches the user's key as a Bearer when present; a keyless local server
 * gets a bare fetch.
 */
export function resolveConnection(
	connection: Connection,
	hosted: ResolvedConnection,
): ResolvedConnection {
	if (connection.kind === 'hosted') return hosted;
	const apiKey = connection.apiKey?.trim();
	const fetch: EngineFetch = apiKey
		? (input, init) => {
				const headers = new Headers(init?.headers);
				headers.set('Authorization', `Bearer ${apiKey}`);
				return globalThis.fetch(input, { ...init, headers });
			}
		: globalThis.fetch.bind(globalThis);
	return { fetch, baseURL: connection.baseUrl };
}

/**
 * Select the connection that serves a conversation's model from the device's set.
 * Pure: the caller assembles `candidates` from the hosted catalog ids and each
 * custom connection's discovered/cached model ids. Returns the first connection
 * whose list contains the model, or `null` when no connection on this device can
 * serve it (the caller then shows the non-destructive banner rather than sending
 * an id the backend will reject). The synced model column is never rewritten here.
 */
export function resolveForModel(
	model: string,
	candidates: readonly { connection: Connection; models: readonly string[] }[],
): Connection | null {
	const match = candidates.find((c) => c.models.includes(model));
	return match?.connection ?? null;
}

export const ListModelsError = defineErrors({
	Unreachable: ({ cause }: { cause: unknown }) => ({
		message: `Could not reach the endpoint to list models: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RequestFailed: ({ status }: { status: number }) => ({
		message: `The endpoint returned ${status} for /models.`,
		status,
	}),
	Malformed: () => ({
		message: 'The /models response was not an OpenAI { data: [{ id }] } list.',
	}),
});
export type ListModelsError = InferErrors<typeof ListModelsError>;

/**
 * List the model ids an OpenAI-compatible endpoint serves (ADR-0058). Best
 * effort: the caller degrades to the free-text model floor on any error. Reads
 * the OpenAI `{ data: [{ id }] }` shape, which Ollama, LM Studio, OpenRouter, and
 * OpenAI all return, so there is no per-provider branch and no `/api/tags`
 * fallback. `/v1/models` carries no capability tag, so the list mixes chat,
 * transcription, and embedding ids; filtering by capability is the caller's job.
 */
export async function listModels(
	resolved: ResolvedConnection,
): Promise<Result<string[], ListModelsError>> {
	const { data: response, error: requestError } = await tryAsync({
		try: () => resolved.fetch(`${resolved.baseURL}/models`, { method: 'GET' }),
		catch: (cause) => ListModelsError.Unreachable({ cause }),
	});
	if (requestError) return Err(requestError);
	if (!response.ok)
		return ListModelsError.RequestFailed({ status: response.status });

	const { data: body, error: parseError } = await tryAsync({
		try: () => response.json() as Promise<unknown>,
		catch: () => ListModelsError.Malformed(),
	});
	if (parseError) return Err(parseError);

	const ids = extractModelIds(body);
	if (!ids) return ListModelsError.Malformed();
	return Ok(ids);
}

/** Pull `id` strings out of an OpenAI `{ data: [{ id }] }` body, or null if the shape is wrong. */
function extractModelIds(body: unknown): string[] | null {
	if (typeof body !== 'object' || body === null || !('data' in body))
		return null;
	const { data } = body as { data: unknown };
	if (!Array.isArray(data)) return null;
	return data.flatMap((entry) =>
		typeof entry === 'object' &&
		entry !== null &&
		'id' in entry &&
		typeof (entry as { id: unknown }).id === 'string'
			? [(entry as { id: string }).id]
			: [],
	);
}
