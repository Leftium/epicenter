import { nanoid } from 'nanoid/non-secure';
import {
	generateDefaultTransformation,
	type Recording,
} from '$lib/services/db';
import { createDbServiceWeb } from '$lib/services/db/web';
import { DownloadServiceLive } from '$lib/services/download';

export const MOCK_RECORDING_COUNT = 10;
export const MOCK_TRANSFORMATION_COUNT = 10;

function createMockRecording(index: number): {
	recording: Recording;
	audio: Blob;
} {
	const id = nanoid();
	const now = new Date().toISOString();
	const statuses = ['DONE', 'UNPROCESSED', 'FAILED'] as const;
	const transcriptionStatus = statuses[index % statuses.length] ?? 'DONE';

	const recording: Recording = {
		id,
		title: `Mock Recording ${index + 1}`,
		subtitle: 'Generated for workspace migration testing',
		timestamp: now,
		createdAt: now,
		updatedAt: now,
		transcribedText: `Mock transcript ${index + 1}`,
		transcriptionStatus,
	};

	const audio = new Blob([`mock-audio-${index}`], { type: 'audio/webm' });

	return { recording, audio };
}

export function createMigrationTestData() {
	const indexedDb = createDbServiceWeb({
		DownloadService: DownloadServiceLive,
	});

	return {
		async seedIndexedDB({
			recordingCount,
			transformationCount,
			onProgress,
		}: {
			recordingCount: number;
			transformationCount: number;
			onProgress: (message: string) => void;
		}): Promise<{ recordings: number; transformations: number }> {
			onProgress(
				`Seeding IndexedDB with ${recordingCount} recordings and ${transformationCount} transformations...`,
			);

			const recordings = Array.from({ length: recordingCount }, (_, index) =>
				createMockRecording(index),
			);

			const { error: recordingsError } =
				await indexedDb.recordings.create(recordings);
			if (recordingsError) {
				throw new Error(
					`Failed to seed recordings: ${recordingsError.message}`,
				);
			}

			const transformations = Array.from(
				{ length: transformationCount },
				(_, index) => {
					const transformation = generateDefaultTransformation();
					transformation.title = `Mock Transformation ${index + 1}`;
					transformation.description =
						'Generated for workspace migration testing';
					return transformation;
				},
			);

			const { error: transformationsError } =
				await indexedDb.transformations.create(transformations);
			if (transformationsError) {
				throw new Error(
					`Failed to seed transformations: ${transformationsError.message}`,
				);
			}

			onProgress(
				`✅ Seed complete: ${recordings.length} recordings, ${transformations.length} transformations`,
			);

			return {
				recordings: recordings.length,
				transformations: transformations.length,
			};
		},

		async clearIndexedDB({
			onProgress,
		}: {
			onProgress: (message: string) => void;
		}): Promise<void> {
			onProgress('Clearing IndexedDB recordings, transformations, and runs...');

			const [recordingsResult, transformationsResult, runsResult] =
				await Promise.all([
					indexedDb.recordings.clear(),
					indexedDb.transformations.clear(),
					indexedDb.runs.clear(),
				]);

			if (recordingsResult.error) {
				throw new Error(
					`Failed to clear recordings: ${recordingsResult.error.message}`,
				);
			}

			if (transformationsResult.error) {
				throw new Error(
					`Failed to clear transformations: ${transformationsResult.error.message}`,
				);
			}

			if (runsResult.error) {
				throw new Error(`Failed to clear runs: ${runsResult.error.message}`);
			}

			onProgress('✅ IndexedDB cleared');
		},
	};
}
