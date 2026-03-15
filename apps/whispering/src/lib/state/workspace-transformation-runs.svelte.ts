/**
 * Reactive transformation run state backed by Yjs workspace tables.
 *
 * Transformation runs track execution records for transformation pipelines.
 * Each run has a status lifecycle: running → completed | failed.
 *
 * During the transition period, new runs are written to workspace tables AND
 * DbService (for backward compatibility). Historical runs that weren't migrated
 * are still available via DbService queries.
 *
 * @example
 * ```typescript
 * import { workspaceTransformationRuns } from '$lib/state/workspace-transformation-runs.svelte';
 *
 * // Get runs for a specific transformation or recording
 * const runs = workspaceTransformationRuns.getByTransformationId(transformationId);
 * const recordingRuns = workspaceTransformationRuns.getByRecordingId(recordingId);
 * ```
 */
import { SvelteMap } from 'svelte/reactivity';
import workspace from '$lib/workspace';

/** Transformation run row type inferred from the workspace table schema. */
export type TransformationRun = ReturnType<
	typeof workspace.tables.transformationRuns.getAllValid
>[number];

function createWorkspaceTransformationRuns() {
	const map = new SvelteMap<string, TransformationRun>();

	// Initialize from current workspace state.
	for (const row of workspace.tables.transformationRuns.getAllValid()) {
		map.set(row.id, row);
	}

	// Observe all changes.
	workspace.tables.transformationRuns.observe((changedIds) => {
		for (const id of changedIds) {
			const result = workspace.tables.transformationRuns.get(id);
			if (result.status === 'valid') {
				map.set(id, result.row);
			} else if (result.status === 'not_found') {
				map.delete(id);
			}
		}
	});

	return {
		/** All transformation runs as a reactive SvelteMap. */
		get all() {
			return map;
		},

		/** Get a run by ID. */
		get(id: string) {
			return map.get(id);
		},

		/**
		 * Get all runs for a transformation, sorted newest-first.
		 *
		 * @param transformationId - FK to the parent transformation
		 */
		getByTransformationId(transformationId: string): TransformationRun[] {
			return Array.from(map.values())
				.filter((run) => run.transformationId === transformationId)
				.sort(
					(a, b) =>
						new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
				);
		},

		/**
		 * Get all runs for a recording, sorted newest-first.
		 *
		 * @param recordingId - FK to the recording
		 */
		getByRecordingId(recordingId: string): TransformationRun[] {
			return Array.from(map.values())
				.filter((run) => run.recordingId === recordingId)
				.sort(
					(a, b) =>
						new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
				);
		},

		/**
		 * Get the latest run for a recording.
		 */
		getLatestByRecordingId(recordingId: string): TransformationRun | undefined {
			return this.getByRecordingId(recordingId)[0];
		},

		/**
		 * Create or update a run.
		 */
		set(run: Omit<TransformationRun, '_v'>) {
			workspace.tables.transformationRuns.set({
				...run,
				_v: 1,
			} as TransformationRun);
		},

		/**
		 * Delete a run by ID.
		 */
		delete(id: string) {
			workspace.tables.transformationRuns.delete(id);
		},

		/** Total number of runs. */
		get count() {
			return map.size;
		},
	};
}

export const workspaceTransformationRuns = createWorkspaceTransformationRuns();
