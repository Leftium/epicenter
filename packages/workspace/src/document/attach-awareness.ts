/**
 * attachAwareness() — Bind awareness definitions to a Y.Doc.
 *
 * Constructs a fresh y-protocols `Awareness` instance over `ydoc` and wraps
 * it with a typed `Awareness<TDefs>` helper. Awareness cleanup is handled by
 * y-protocols — its constructor registers `doc.on('destroy', () => this.destroy())`,
 * so destroying the ydoc tears down the Awareness automatically.
 *
 * To wire awareness into a sync attachment, pass `awareness.raw` (the
 * underlying y-protocols `Awareness`) to
 * `attachSync(ydoc, { awareness: awareness.raw, ... })`.
 */

import { Awareness as YAwareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { CombinedStandardSchema } from './standard-schema.js';

// ════════════════════════════════════════════════════════════════════════════
// AWARENESS TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Map of awareness field definitions. Each field has its own CombinedStandardSchema schema. */
export type AwarenessDefinitions = Record<string, CombinedStandardSchema>;

/** Extract the output type of an awareness field's schema. */
export type InferAwarenessValue<T> =
	T extends CombinedStandardSchema<unknown, infer TOutput> ? TOutput : never;

/**
 * The composed state type — all fields optional since peers may not have set every field.
 */
export type AwarenessState<TDefs extends AwarenessDefinitions> = {
	[K in keyof TDefs]?: InferAwarenessValue<TDefs[K]>;
};

/**
 * Typed handle over a y-protocols `Awareness` instance.
 *
 * The y-protocols class is aliased as `YAwareness` inside this module so the
 * exported type name `Awareness<TDefs>` doesn't shadow it. Consumers that
 * import both should alias the y-protocols import similarly.
 */
export type Awareness<TDefs extends AwarenessDefinitions> = {
	setLocal(state: AwarenessState<TDefs>): void;

	setLocalField<K extends keyof TDefs & string>(
		key: K,
		value: InferAwarenessValue<TDefs[K]>,
	): void;

	getLocal(): AwarenessState<TDefs> | null;

	getLocalField<K extends keyof TDefs & string>(
		key: K,
	): InferAwarenessValue<TDefs[K]> | undefined;

	getAll(): Map<number, AwarenessState<TDefs>>;

	peers(): Map<number, AwarenessState<TDefs>>;

	observe(
		callback: (changes: Map<number, 'added' | 'updated' | 'removed'>) => void,
	): () => void;

	raw: YAwareness;
};

/**
 * Bind a record of awareness field definitions to a Y.Doc.
 *
 * Each field is independently validated on read. The underlying
 * `Awareness` instance tears itself down on `ydoc.destroy()` via a handler
 * registered by `y-protocols` in its constructor.
 *
 * @param ydoc - The Y.Doc to attach awareness to
 * @param definitions - Map of field name to StandardSchema
 */
export function attachAwareness<TDefs extends AwarenessDefinitions>(
	ydoc: Y.Doc,
	definitions: TDefs,
): Awareness<TDefs> {
	return createAwareness(new YAwareness(ydoc), definitions);
}

/**
 * Wrap an existing y-protocols `Awareness` instance with a typed helper.
 *
 * Exported so `@epicenter/workspace` can reuse the same logic — the
 * workspace owns its own Awareness instance for sync extension wiring.
 */
export function createAwareness<TDefs extends AwarenessDefinitions>(
	awareness: YAwareness,
	definitions: TDefs,
): Awareness<TDefs> {
	const defEntries = Object.entries(definitions);

	/** Validate awareness state fields against schemas. */
	function validateState(state: unknown): Record<string, unknown> {
		const validated: Record<string, unknown> = {};
		for (const [fieldKey, fieldSchema] of defEntries) {
			const fieldValue = (state as Record<string, unknown>)[fieldKey];
			if (fieldValue === undefined) continue;

			const fieldResult = fieldSchema['~standard'].validate(fieldValue);
			if (fieldResult instanceof Promise) continue;
			if (fieldResult.issues) continue;

			validated[fieldKey] = fieldResult.value;
		}
		return validated;
	}

	return {
		setLocal(state) {
			const current = awareness.getLocalState() ?? {};
			awareness.setLocalState({ ...current, ...state });
		},

		setLocalField(key, value) {
			awareness.setLocalStateField(key, value);
		},

		getLocal() {
			return awareness.getLocalState() as AwarenessState<TDefs> | null;
		},

		getLocalField(key) {
			const state = awareness.getLocalState();
			if (state === null) return undefined;
			return (state as Record<string, unknown>)[key] as ReturnType<
				Awareness<TDefs>['getLocalField']
			>;
		},

		getAll() {
			const result = new Map<number, AwarenessState<TDefs>>();
			for (const [clientId, state] of awareness.getStates()) {
				if (state === null || typeof state !== 'object') continue;
				const validated = validateState(state);
				if (Object.keys(validated).length > 0) {
					result.set(clientId, validated as AwarenessState<TDefs>);
				}
			}
			return result;
		},

		peers() {
			const result = new Map<number, AwarenessState<TDefs>>();
			const selfId = awareness.clientID;
			for (const [clientId, state] of awareness.getStates()) {
				if (clientId === selfId) continue;
				if (state === null || typeof state !== 'object') continue;
				result.set(clientId, validateState(state) as AwarenessState<TDefs>);
			}
			return result;
		},

		observe(callback) {
			const handler = ({
				added,
				updated,
				removed,
			}: {
				added: number[];
				updated: number[];
				removed: number[];
			}) => {
				const changes = new Map<number, 'added' | 'updated' | 'removed'>();
				for (const id of added) changes.set(id, 'added');
				for (const id of updated) changes.set(id, 'updated');
				for (const id of removed) changes.set(id, 'removed');
				callback(changes);
			};
			awareness.on('change', handler);
			return () => awareness.off('change', handler);
		},

		raw: awareness,
	};
}
