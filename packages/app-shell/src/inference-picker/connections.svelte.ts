/**
 * The device-local inference connection registry (ADR-0059): one cohesive object
 * that owns the device's set of custom OpenAI-compatible connections plus the
 * model ids each was discovered to serve, and resolves a conversation's model to a
 * transport. Every chat app instantiates this once instead of re-deriving the same
 * two persisted stores, so the picker, the engine, and the cross-device banner all
 * read one source.
 *
 * Device-local, never synced: a key is a secret on the plaintext relay and a
 * `localhost` URL is meaningless elsewhere (ADR-0004). The arktype schema here is
 * the single runtime shape; `Connection` (from `@epicenter/client`) is the
 * matching compile-time type.
 */

import {
	type Connection,
	type ListModelsError,
	listModels,
	type ResolvedConnection,
	resolveConnection,
} from '@epicenter/client';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import type { Result } from 'wellcrafted/result';

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

const connectionSchema = type({
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
		connectionSchema.array(),
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

	/** The candidates a model resolves against, in priority order: every custom
	 * connection (the user's own key) BEFORE hosted. The hosted catalog sells real
	 * upstream ids (e.g. `gpt-5.5`), so a user who adds their own OpenAI key serves a
	 * colliding id; matching custom first resolves that turn to the user's key
	 * instead of silently metering it against Epicenter credits. Hosted is the last
	 * resort, serving only ids no custom connection on this device claims.
	 *
	 * Each candidate carries its own `resolve` thunk, so matching never branches on
	 * what a candidate is: a custom connection closes over `resolveConnection`
	 * (static data -> transport); hosted closes over the injected transport. The
	 * `kind` discriminant is gone (ADR-0060). */
	function candidates(): {
		resolve: () => ResolvedConnection;
		models: readonly string[];
	}[] {
		return [
			...custom.current.map((connection) => ({
				resolve: () => resolveConnection(connection),
				models: discovered.current[connection.baseUrl] ?? [],
			})),
			{ resolve: () => hosted, models: hostedModels.map((m) => m.id) },
		];
	}

	/** Resolve a conversation's model (ADR-0055) to its transport, or `null` when no
	 * connection on this device serves it. Internal: the served/unserved predicate
	 * has one definition here, exposed as `resolveOrHosted` (transport) and
	 * `canServe` (boolean) so neither the engine nor the UI re-derives it. */
	function resolve(model: string): ResolvedConnection | null {
		return (
			candidates()
				.find((c) => c.models.includes(model))
				?.resolve() ?? null
		);
	}

	return {
		/** The hosted catalog this app sells (for the picker's Epicenter group). */
		hostedModels,
		/** The device's custom connections, in display order. */
		get custom() {
			return custom.current;
		},
		/** Discovered model ids per connection, keyed by base URL. */
		get discoveredModels() {
			return discovered.current;
		},

		/** Add (or replace by base URL) a connection, optionally caching its models. */
		add(connection: Connection, models?: string[]) {
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

		/** Discover the models a candidate endpoint serves (best effort, never throws). */
		discover(
			baseUrl: string,
			apiKey?: string,
		): Promise<Result<string[], ListModelsError>> {
			return listModels(
				resolveConnection({ baseUrl, apiKey: apiKey || undefined }),
			);
		},

		/**
		 * The transport for a conversation's model, falling back to the hosted
		 * connection when no device connection serves it. The fallback ships the
		 * unservable model id to the gateway, which errors loudly; callers gate
		 * sending via {@link canServe}, so this fires only on a path the UI blocks and
		 * never silently substitutes a different model.
		 */
		resolveOrHosted(model: string): ResolvedConnection {
			return resolve(model) ?? hosted;
		},
		/**
		 * Whether a connection on this device serves the model. The single predicate
		 * behind both the cross-device banner and the send gate; never rewrites the
		 * synced model column.
		 */
		canServe(model: string): boolean {
			return resolve(model) !== null;
		},
	};
}
