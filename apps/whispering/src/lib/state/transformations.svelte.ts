/**
 * Reactive transformation state backed by Yjs workspace tables.
 *
 * A transformation is a single self-contained row: title, description, and the
 * fixed three-phase shape (`preReplacements`, `prompt`, `postReplacements`).
 * There is no separate steps table.
 *
 * @example
 * ```typescript
 * import { transformations } from '$lib/state/transformations.svelte';
 *
 * // Read reactively
 * const transformation = transformations.get(id);
 * const all = transformations.sorted; // alphabetical by title
 *
 * // Write
 * transformations.set(transformation);
 * transformations.delete(id);
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { nanoid } from 'nanoid/non-secure';
import { whispering } from '#platform/whispering';
import type { Transformation, TransformationPrompt } from '$lib/workspace';

/**
 * A fresh prompt phase for when the user enables the AI prompt on a
 * transformation: Google's fast model, no templates yet. A factory, not a shared
 * constant, so each transformation owns its own prompt object and two can never
 * alias the same one.
 */
export function createDefaultPrompt(): TransformationPrompt {
	return {
		inferenceProvider: 'Google',
		model: 'gemini-2.5-flash',
		systemPromptTemplate: '',
		userPromptTemplate: '',
	};
}

function createTransformations() {
	const map = fromTable(whispering.tables.transformations);

	// Memoize sorted array with $derived for referential stability.
	const sorted = $derived(
		[...map.values()].sort((a, b) => a.title.localeCompare(b.title)),
	);

	return {
		[Symbol.dispose]() {
			map[Symbol.dispose]();
		},

		/**
		 * All transformations as a reactive SvelteMap.
		 *
		 * Components reading this re-render per-key when transformations change.
		 */
		get all() {
			return map;
		},

		/**
		 * Get a transformation by ID. Returns undefined if not found.
		 */
		get(id: string) {
			return map.get(id);
		},

		/**
		 * All transformations as a sorted array (alphabetical by title).
		 * Memoized via `$derived`. Stable reference until SvelteMap changes.
		 */
		get sorted(): Transformation[] {
			return sorted;
		},

		/**
		 * Create or update a transformation. Writes to Yjs → observer updates SvelteMap.
		 */
		set(transformation: Transformation) {
			whispering.tables.transformations.set(transformation);
		},

		/**
		 * Partially update a transformation by ID.
		 */
		update(id: string, partial: Partial<Omit<Transformation, 'id' | '_v'>>) {
			return whispering.tables.transformations.update(id, partial);
		},

		/**
		 * Delete a transformation by ID.
		 */
		delete(id: string) {
			whispering.tables.transformations.delete(id);
		},

		/** Total number of transformations. */
		get count() {
			return map.size;
		},
	};
}

export const transformations = createTransformations();

if (import.meta.hot) {
	import.meta.hot.dispose(() => transformations[Symbol.dispose]());
}

/**
 * Generate a default transformation: empty title and description, both
 * replacement lists empty, and no prompt phase. Returns a full `Transformation`
 * row ready to pass straight to `transformations.set()`.
 *
 * @example
 * ```typescript
 * const t = generateDefaultTransformation();
 * transformations.set(t);
 * ```
 */
export function generateDefaultTransformation(): Transformation {
	return {
		id: nanoid(),
		title: '',
		description: '',
		preReplacements: [],
		prompt: null,
		postReplacements: [],
	};
}

/**
 * Whether a transformation has at least one phase to run: a pre-replacement, the
 * prompt, or a post-replacement. This is the "runnable" invariant, shared by the
 * runtime guard in `runTransformation` and the editor's run-button state.
 */
export function transformationHasWork(transformation: Transformation): boolean {
	return (
		transformation.preReplacements.length > 0 ||
		transformation.prompt !== null ||
		transformation.postReplacements.length > 0
	);
}

