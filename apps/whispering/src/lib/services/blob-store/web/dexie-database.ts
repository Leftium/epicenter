import Dexie from 'dexie';
import type { AudioStoredInIndexedDB, SerializedAudio } from './dexie-schemas';

const DB_NAME = 'RecordingDB';

/**
 * Convert Blob to serialized format for IndexedDB storage.
 * Returns undefined if conversion fails.
 */
export async function blobToSerializedAudio(
	blob: Blob,
): Promise<SerializedAudio | undefined> {
	const arrayBuffer = await blob.arrayBuffer().catch((error) => {
		console.error('Error getting array buffer from blob', blob, error);
		return undefined;
	});

	if (!arrayBuffer) return undefined;

	return { arrayBuffer, blobType: blob.type };
}

export class WhisperingDatabase extends Dexie {
	recordings!: Dexie.Table<AudioStoredInIndexedDB, string>;

	constructor() {
		super(DB_NAME);

		// Single collapsed schema at version 0.6 (the current version).
		// Existing databases already migrated through V1-V6; new installs
		// get V6 directly. Table declarations for transformations and
		// transformationRuns are kept so Dexie doesn't delete their data.
		this.version(0.6).stores({
			recordings: '&id, timestamp, createdAt, updatedAt',
			transformations: '&id, createdAt, updatedAt',
			transformationRuns: '&id, transformationId, recordingId, startedAt',
		});
	}
}
