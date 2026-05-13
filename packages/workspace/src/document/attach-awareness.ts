/**
 * attachAwareness(): Bind a typed schema to a y-protocols `Awareness`.
 *
 * Wraps an existing `Awareness` instance with a `AwarenessAttachment<TSchema>`
 * helper: `setLocal` merges typed fields into the local state, `peers`
 * returns validated remote states, `observe` reports change deltas.
 *
 * The caller owns the `Awareness`. Construct it with `new Awareness(ydoc)`,
 * or pass `workspace.awareness` from `openWorkspace` to compose custom
 * presence (cursors, selections) on top of the workspace's `identity` and
 * `actionPaths` fields. Awareness teardown happens automatically when the
 * underlying ydoc is destroyed: y-protocols registers a `destroy` listener
 * inside its own constructor.
 *
 * Multiple `attachAwareness` calls against the same `Awareness` instance
 * compose: `setLocal` merges fields into the existing local state rather
 * than overwriting, so reserved keys (e.g., `identity`/`actionPaths` owned
 * by `openWorkspace`) and custom keys coexist.
 *
 * Awareness invariants (from y-protocols/awareness):
 *
 *   - **Ephemeral.** ~30s liveness window; peers that crashed silently
 *     disappear after `outdatedTimeout`. Awareness is a liveness probe,
 *     not a directory.
 *   - **clientID is session-local.** Re-randomized on every `new Y.Doc()`,
 *     so numeric clientIDs are stable within one presence session only.
 *   - **No field-name convention.** Bundles that want stable addressing
 *     across reconnects persist an identifier locally and publish it into
 *     awareness under whatever name they choose.
 */

import type { Awareness as YAwareness } from 'y-protocols/awareness';
import type { CombinedStandardSchema } from './standard-schema.js';

// ════════════════════════════════════════════════════════════════════════════
// AWARENESS TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Map of awareness fields. Each field has its own CombinedStandardSchema schema. */
export type AwarenessSchema = Record<string, CombinedStandardSchema>;

/** Extract the output type of an awareness field's schema. */
export type InferAwarenessValue<T> =
	T extends CombinedStandardSchema<unknown, infer TOutput> ? TOutput : never;

/**
 * The composed state type. All fields are required: `attachAwareness` takes an
 * `initial` value for every defined field and publishes it synchronously
 * before returning, so any state on the wire (including the local one) is
 * guaranteed to carry every defined field. If you define a field, you publish
 * a value. There is no "field defined but not yet set" window.
 */
export type AwarenessState<TSchema extends AwarenessSchema> = {
	[K in keyof TSchema]: InferAwarenessValue<TSchema[K]>;
};

/**
 * Typed handle over a y-protocols `Awareness` instance.
 *
 */
export type AwarenessAttachment<TSchema extends AwarenessSchema> = {
	setLocal(state: Partial<AwarenessState<TSchema>>): void;

	peers(): Map<number, AwarenessState<TSchema>>;

	observe(
		callback: (changes: Map<number, 'added' | 'updated' | 'removed'>) => void,
	): () => void;

	raw: YAwareness;
};

/**
 * Bind a typed schema to an existing y-protocols `Awareness`.
 *
 * `initial` carries the starting value for every defined field. It is set
 * synchronously before the function returns, so the local state on the wire
 * is well-formed from the first frame. No consumer ever observes a peer
 * with a field defined but unset.
 *
 * Fields can still be updated later via `setLocal`, which merges into the
 * existing local state rather than overwriting. Multiple `attachAwareness`
 * calls against the same `Awareness` compose.
 *
 * Each field is independently validated on read. The underlying `Awareness`
 * tears itself down on its ydoc's `destroy` event via a handler registered
 * by `y-protocols` in its constructor.
 *
 * @param awareness - The Awareness instance to attach the typed schema to
 * @param options - Schema and starting value for every defined field
 */
export function attachAwareness<TSchema extends AwarenessSchema>(
	awareness: YAwareness,
	{
		schema,
		initial,
	}: {
		schema: TSchema;
		initial: AwarenessState<TSchema>;
	},
): AwarenessAttachment<TSchema> {
	const attachment = createAwarenessAttachment(awareness, schema);
	attachment.setLocal(initial);
	return attachment;
}

/**
 * Wrap an existing y-protocols `Awareness` instance with a typed helper.
 */
function createAwarenessAttachment<TSchema extends AwarenessSchema>(
	awareness: YAwareness,
	schema: TSchema,
): AwarenessAttachment<TSchema> {
	const defEntries = Object.entries(schema);

	/**
	 * Validate awareness state: every defined field must be present and
	 * pass its schema. Returns `null` if any field is missing or invalid.
	 * This matches the publish-time invariant from `attachAwareness`: a
	 * peer that publishes any state publishes all defined fields.
	 */
	function validateState(
		state: Record<string, unknown>,
	): Record<string, unknown> | null {
		const validated: Record<string, unknown> = {};
		for (const [fieldKey, fieldSchema] of defEntries) {
			const fieldValue = state[fieldKey];
			if (fieldValue === undefined) return null;

			const fieldResult = fieldSchema['~standard'].validate(fieldValue);
			if (fieldResult instanceof Promise) return null;
			if (fieldResult.issues) return null;

			validated[fieldKey] = fieldResult.value;
		}
		return validated;
	}

	return {
		setLocal(state) {
			const current = awareness.getLocalState() ?? {};
			awareness.setLocalState({ ...current, ...state });
		},

		peers() {
			const result = new Map<number, AwarenessState<TSchema>>();
			const selfId = awareness.clientID;
			for (const [clientId, state] of awareness.getStates()) {
				if (clientId === selfId) continue;
				if (state === null || typeof state !== 'object') continue;
				const validated = validateState(state);
				if (validated !== null) {
					result.set(clientId, validated as AwarenessState<TSchema>);
				}
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
