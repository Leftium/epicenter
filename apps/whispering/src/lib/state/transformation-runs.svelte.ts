/**
 * Reactive transformation run state backed by Yjs workspace tables.
 *
 * Transformation runs track execution records. A run stores only its terminal
 * outcome in `result` (completed or failed); while it is executing or if it was
 * interrupted, `result` is null and liveness is derived from `startedAt`, never
 * stored. See
 * docs/articles/20260612T190745-liveness-belongs-to-the-process-not-the-row.md.
 *
 * @example
 * ```typescript
 * import { transformationRuns } from '$lib/state/transformation-runs.svelte';
 *
 * // Get runs for a specific transformation or recording
 * const runs = transformationRuns.getByTransformationId(transformationId);
 * const recordingRuns = transformationRuns.getByRecordingId(recordingId);
 * ```
 */
import { fromTable } from '@epicenter/svelte';
import { whispering } from '#platform/whispering';
import type { TransformationRun } from '$lib/workspace';

function createTransformationRuns() {
	const view = fromTable(whispering.tables.transformationRuns);

	return {
		/** Get a run by ID. */
		get(id: string) {
			return view.byId(id);
		},

		/**
		 * Get all runs for a transformation, sorted newest-first.
		 *
		 * @param transformationId - FK to the parent transformation
		 */
		getByTransformationId(transformationId: string): TransformationRun[] {
			return view.all
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
			return view.all
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
			whispering.tables.transformationRuns.set({
				...run,
			} as TransformationRun);
		},

		/**
		 * Delete a run by ID.
		 */
		delete(id: string) {
			whispering.tables.transformationRuns.delete(id);
		},

		/** Total number of runs. */
		get count() {
			return view.all.length;
		},
	};
}

export const transformationRuns = createTransformationRuns();
