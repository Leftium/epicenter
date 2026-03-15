/**
 * Reactive transformation step state backed by Yjs workspace tables.
 *
 * Steps are stored as a separate table (not nested in transformations).
 * Each step has a `transformationId` FK and an `order` field for sequencing.
 * The `getByTransformationId()` helper filters and sorts by order.
 *
 * @example
 * ```typescript
 * import { workspaceTransformationSteps } from '$lib/state/workspace-transformation-steps.svelte';
 *
 * // Get steps for a specific transformation, sorted by order
 * const steps = workspaceTransformationSteps.getByTransformationId(transformationId);
 *
 * // CRUD
 * workspaceTransformationSteps.set(step);
 * workspaceTransformationSteps.delete(stepId);
 * ```
 */
import { SvelteMap } from 'svelte/reactivity';
import workspace from '$lib/workspace';

/** Transformation step row type inferred from the workspace table schema. */
export type TransformationStep = ReturnType<
	typeof workspace.tables.transformationSteps.getAllValid
>[number];

/**
 * A transformation step without the workspace version tag (`_v`).
 *
 * Used in UI components and save utilities where the version is managed
 * automatically by the workspace table layer.
 */
export type TransformationStepDraft = Omit<TransformationStep, '_v'>;

function createWorkspaceTransformationSteps() {
	const map = new SvelteMap<string, TransformationStep>();

	// Initialize from current workspace state.
	for (const row of workspace.tables.transformationSteps.getAllValid()) {
		map.set(row.id, row);
	}

	// Observe all changes (local writes, remote CRDT sync, migration).
	workspace.tables.transformationSteps.observe((changedIds) => {
		for (const id of changedIds) {
			const result = workspace.tables.transformationSteps.get(id);
			if (result.status === 'valid') {
				map.set(id, result.row);
			} else if (result.status === 'not_found') {
				map.delete(id);
			}
		}
	});

	return {
		/**
		 * All transformation steps as a reactive SvelteMap.
		 */
		get all() {
			return map;
		},

		/**
		 * Get a step by ID. Returns undefined if not found.
		 */
		get(id: string) {
			return map.get(id);
		},

		/**
		 * Get all steps for a transformation, sorted by order.
		 *
		 * This is the primary query method—replaces the old `transformation.steps[]`
		 * nested array pattern. Steps are now a separate table with `transformationId` FK.
		 *
		 * @param transformationId - FK to the parent transformation
		 * @returns Steps sorted by `order` field (ascending)
		 */
		getByTransformationId(transformationId: string): TransformationStep[] {
			return Array.from(map.values())
				.filter((step) => step.transformationId === transformationId)
				.sort((a, b) => a.order - b.order);
		},

		/**
		 * Create or update a step. Writes to Yjs → observer updates SvelteMap.
		 *
		 * Accepts a step without `_v` (version tag is added automatically).
		 */
		set(step: TransformationStepDraft) {
			workspace.tables.transformationSteps.set({
				...step,
				_v: 1,
			} as TransformationStep);
		},

		/**
		 * Partially update a step by ID.
		 */
		update(
			id: string,
			partial: Partial<Omit<TransformationStep, 'id' | '_v'>>,
		) {
			return workspace.tables.transformationSteps.update(id, partial);
		},

		/**
		 * Delete a step by ID.
		 */
		delete(id: string) {
			workspace.tables.transformationSteps.delete(id);
		},

		/**
		 * Delete all steps for a transformation.
		 *
		 * Useful when deleting a transformation—removes all child steps.
		 */
		deleteByTransformationId(transformationId: string) {
			for (const [id, step] of map) {
				if (step.transformationId === transformationId) {
					workspace.tables.transformationSteps.delete(id);
				}
			}
		},

		/** Total number of steps across all transformations. */
		get count() {
			return map.size;
		},
	};
}

export const workspaceTransformationSteps =
	createWorkspaceTransformationSteps();

/**
 * Generate a default transformation step with sensible defaults.
 *
 * Uses flat workspace field names. The `transformationId` and `order` are
 * set by the caller (they depend on the parent transformation and insertion position).
 *
 * @example
 * ```typescript
 * const step = generateDefaultStep({
 *   transformationId: transformation.id,
 *   order: existingSteps.length,
 * });
 * workspaceTransformationSteps.set(step);
 * ```
 */
export function generateDefaultStep(
	context: Pick<TransformationStep, 'transformationId' | 'order'>,
): TransformationStepDraft {
	return {
		id: crypto.randomUUID(),
		transformationId: context.transformationId,
		order: context.order,
		type: 'prompt_transform',
		inferenceProvider: 'Google',
		openaiModel: 'gpt-4o',
		groqModel: 'llama-3.3-70b-versatile',
		anthropicModel: 'claude-sonnet-4-0',
		googleModel: 'gemini-2.5-flash',
		openrouterModel: 'mistralai/mixtral-8x7b',
		customModel: '',
		customBaseUrl: '',
		systemPromptTemplate: '',
		userPromptTemplate: '',
		findText: '',
		replaceText: '',
		useRegex: false,
	};
}
