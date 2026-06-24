/**
 * The device-local inference connection registry (ADR-0058): one cohesive object
 * that owns the device's set of custom OpenAI-compatible connections plus the
 * model ids each was discovered to serve, and resolves a conversation's model to a
 * transport. Every chat app instantiates this once instead of re-deriving the same
 * two persisted stores, so the picker, the engine, and the cross-device banner all
 * read one source.
 *
 * Device-local, never synced: a key is a secret on the plaintext relay and a
 * `localhost` URL is meaningless elsewhere (ADR-0004). The arktype schema here is
 * the single runtime shape; `CustomConnection` is the matching compile-time type.
 */

import {
	type Connection,
	type ListModelsError,
	listModels,
	type ResolvedConnection,
	resolveConnection,
	resolveForModel,
} from '@epicenter/client';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import type { Result } from 'wellcrafted/result';

/** A custom (non-hosted) connection: the registry holds a set of these. */
export type CustomConnection = Extract<Connection, { kind: 'custom' }>;

/**
 * A reactive persisted-state handle: localStorage (web) or chrome.storage
 * (extension). Both backends expose this identical `{ current }` interface, so
 * the registry binds against the shape and the app injects the mechanism.
 */
export type PersistedState<T> = { current: T };

/**
 * Builds one persisted slice from a key + schema + default value. The app
 * supplies the mechanism (web: `createPersistedState`; extension:
 * `createStorageState`), so `@epicenter/app-shell` depends on neither storage
 * backend.
 */
export type PersistFactory = <S extends StandardSchemaV1>(
	key: string,
	schema: S,
	defaultValue: StandardSchemaV1.InferOutput<S>,
) => PersistedState<StandardSchemaV1.InferOutput<S>>;

/**
 * One hosted catalog entry the app sells. Injected, not imported: the hosted
 * catalog is app-specific (Vocab offers a model the others do not), so the shared
 * registry never reaches into `@epicenter/constants`.
 */
export type HostedModel = { id: string; label: string; credits: number };

const customConnectionSchema = type({
	kind: "'custom'",
	'preset?': "'ollama' | 'lmstudio' | 'openai' | 'openrouter' | 'groq'",
	baseUrl: 'string',
	'apiKey?': 'string',
});

/** Discovered model ids per connection, keyed by base URL. */
const discoveredModelsSchema = type({ '[string]': 'string[]' });

/** The reactive registry object returned by {@link createInferenceConnections}. */
export type InferenceConnections = ReturnType<
	typeof createInferenceConnections
>;

export function createInferenceConnections({
	storageKey,
	hostedModels,
	hosted,
	persist,
}: {
	/** Namespace for the persisted-state keys, e.g. the app name. */
	storageKey: string;
	/** The hosted catalog this app sells (app-specific subset). */
	hostedModels: HostedModel[];
	/** The hosted transport (`auth.fetch` + gateway base URL). */
	hosted: ResolvedConnection;
	/** The persistence mechanism (web: localStorage; extension: chrome.storage). */
	persist: PersistFactory;
}) {
	const custom = persist(
		`${storageKey}.inference-connections`,
		customConnectionSchema.array(),
		[],
	);
	const discovered = persist(
		`${storageKey}.discovered-models`,
		discoveredModelsSchema,
		{},
	);

	function cacheModels(baseUrl: string, models: string[]) {
		discovered.current = { ...discovered.current, [baseUrl]: models };
	}

	/** The list `resolveForModel` matches against: the hosted connection plus each
	 * custom connection paired with the ids it was discovered to serve. */
	function candidates(): {
		connection: Connection;
		models: readonly string[];
	}[] {
		return [
			{ connection: { kind: 'hosted' }, models: hostedModels.map((m) => m.id) },
			...custom.current.map((connection) => ({
				connection,
				models: discovered.current[connection.baseUrl] ?? [],
			})),
		];
	}

	return {
		/** The hosted catalog this app sells (for the picker's Epicenter group). */
		hostedModels,
		/** The hosted transport, for an engine's defensive fallback. */
		hosted,
		/** The device's custom connections, in display order. */
		get custom() {
			return custom.current;
		},
		/** Discovered model ids per connection, keyed by base URL. */
		get discoveredModels() {
			return discovered.current;
		},

		/** Add (or replace by base URL) a connection, optionally caching its models. */
		add(connection: CustomConnection, models?: string[]) {
			custom.current = [
				...custom.current.filter((c) => c.baseUrl !== connection.baseUrl),
				connection,
			];
			if (models) cacheModels(connection.baseUrl, models);
		},
		/** Forget a connection by base URL. */
		remove(baseUrl: string) {
			custom.current = custom.current.filter((c) => c.baseUrl !== baseUrl);
		},
		cacheModels,

		/** Discover the models a candidate endpoint serves (best effort, never throws). */
		discover(
			baseUrl: string,
			apiKey?: string,
		): Promise<Result<string[], ListModelsError>> {
			const connection: Connection = {
				kind: 'custom',
				baseUrl,
				apiKey: apiKey || undefined,
			};
			return listModels(resolveConnection(connection, hosted));
		},

		/**
		 * Resolve a conversation's model (ADR-0055) to its transport, or `null` when
		 * no connection on this device serves it (the banner trigger). Never rewrites
		 * the synced model column.
		 */
		resolve(model: string): ResolvedConnection | null {
			const connection = resolveForModel(model, candidates());
			return connection ? resolveConnection(connection, hosted) : null;
		},
	};
}
