import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

import type {
	TransformationRun,
	TransformationRunCompleted,
	TransformationRunFailed,
	TransformationStepRun,
} from './models';

export const DbError = defineErrors({
	QueryFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to query database: ${extractErrorMessage(cause)}`,
		cause,
	}),
	MutationFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to write to database: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type DbError = InferErrors<typeof DbError>;

export type DbService = {
	audio: {
		save(recordingId: string, audio: Blob): Promise<Result<void, DbError>>;
		delete(id: string | string[]): Promise<Result<void, DbError>>;
		clear(): Promise<Result<void, DbError>>;

		/**
		 * Get audio blob by recording ID. Fetches audio on-demand.
		 * - Desktop: Reads file from predictable path using services.fs.pathToBlob()
		 * - Web: Fetches from IndexedDB by ID, converts serializedAudio to Blob
		 */
		getBlob(recordingId: string): Promise<Result<Blob, DbError>>;

		/**
		 * Get audio playback URL. Creates and caches URL.
		 * - Desktop: Uses convertFileSrc() to create asset:// URL
		 * - Web: Creates and caches object URL, manages lifecycle
		 */
		ensurePlaybackUrl(
			recordingId: string,
		): Promise<Result<string, DbError>>;

		/**
		 * Revoke audio URL if cached. Cleanup method.
		 * - Desktop: No-op (asset:// URLs managed by Tauri)
		 * - Web: Calls URL.revokeObjectURL() and removes from cache
		 */
		revokeUrl(recordingId: string): void;
	};
	runs: {
		getAll(): Promise<Result<TransformationRun[], DbError>>;
		getById(id: string): Promise<Result<TransformationRun | null, DbError>>;
		getByTransformationId(
			transformationId: string,
		): Promise<Result<TransformationRun[], DbError>>;
		getByRecordingId(
			recordingId: string,
		): Promise<Result<TransformationRun[], DbError>>;
		create(
			run: TransformationRun | TransformationRun[],
		): Promise<Result<void, DbError>>;
		addStep(
			run: TransformationRun,
			step: {
				id: string;
				input: string;
			},
		): Promise<Result<TransformationStepRun, DbError>>;
		failStep(
			run: TransformationRun,
			stepRunId: string,
			error: string,
		): Promise<Result<TransformationRunFailed, DbError>>;
		completeStep(
			run: TransformationRun,
			stepRunId: string,
			output: string,
		): Promise<Result<TransformationRun, DbError>>;
		complete(
			run: TransformationRun,
			output: string,
		): Promise<Result<TransformationRunCompleted, DbError>>;
		delete(
			run: TransformationRun | TransformationRun[],
		): Promise<Result<void, DbError>>;
		clear(): Promise<Result<void, DbError>>;
		getCount(): Promise<Result<number, DbError>>;
	};
};
