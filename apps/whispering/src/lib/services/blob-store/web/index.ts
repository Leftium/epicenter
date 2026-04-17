import { tryAsync } from 'wellcrafted/result';
import { BlobError, type BlobStore } from '../types';
import { WhisperingDatabase } from './dexie-database';
import type { SerializedAudio } from './dexie-schemas';

/**
 * Convert Blob to serialized format for IndexedDB storage.
 * Returns undefined if conversion fails.
 */
async function blobToSerializedAudio(
	blob: Blob,
): Promise<SerializedAudio | undefined> {
	const arrayBuffer = await blob.arrayBuffer().catch((error) => {
		console.error('Error getting array buffer from blob', blob, error);
		return undefined;
	});

	if (!arrayBuffer) return undefined;

	return { arrayBuffer, blobType: blob.type };
}

/**
 * Convert serialized audio back to Blob for use in the application.
 */
function serializedAudioToBlob(serializedAudio: SerializedAudio): Blob {
	return new Blob([serializedAudio.arrayBuffer], {
		type: serializedAudio.blobType,
	});
}

export function createBlobStoreWeb(): BlobStore {
	const db = new WhisperingDatabase();
	/** Cache for audio object URLs to avoid recreating them. */
	const audioUrlCache = new Map<string, string>();

	return {
		async save(recordingId, audio) {
			const serializedAudio = await blobToSerializedAudio(audio);
			return tryAsync({
				try: async () => {
					await db.recordings.put({ id: recordingId, serializedAudio });
				},
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},

		delete: async (idOrIds) => {
			const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
			return tryAsync({
				try: () => db.recordings.bulkDelete(ids),
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},

		getBlob: async (recordingId) => {
			return tryAsync({
				try: async () => {
					const recordingWithAudio = await db.recordings.get(recordingId);

					if (!recordingWithAudio) {
						throw new Error(`Recording ${recordingId} not found`);
					}

					if (!recordingWithAudio.serializedAudio) {
						throw new Error(`No audio found for recording ${recordingId}`);
					}

					const blob = serializedAudioToBlob(
						recordingWithAudio.serializedAudio,
					);
					return blob;
				},
				catch: (error) => BlobError.ReadFailed({ cause: error }),
			});
		},

		ensurePlaybackUrl: async (recordingId) => {
			return tryAsync({
				try: async () => {
					// Check cache first
					const cachedUrl = audioUrlCache.get(recordingId);
					if (cachedUrl) {
						return cachedUrl;
					}

					// Fetch blob from IndexedDB
					const recordingWithAudio = await db.recordings.get(recordingId);

					if (!recordingWithAudio) {
						throw new Error(`Recording ${recordingId} not found`);
					}

					if (!recordingWithAudio.serializedAudio) {
						throw new Error(`No audio found for recording ${recordingId}`);
					}

					const blob = serializedAudioToBlob(
						recordingWithAudio.serializedAudio,
					);
					const objectUrl = URL.createObjectURL(blob);
					audioUrlCache.set(recordingId, objectUrl);

					return objectUrl;
				},
				catch: (error) => BlobError.ReadFailed({ cause: error }),
			});
		},

		revokeUrl: (recordingId) => {
			const url = audioUrlCache.get(recordingId);
			if (url) {
				URL.revokeObjectURL(url);
				audioUrlCache.delete(recordingId);
			}
		},

		clear: async () => {
			return tryAsync({
				try: () => db.recordings.clear(),
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},
	};
}
