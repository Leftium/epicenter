import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

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
};
