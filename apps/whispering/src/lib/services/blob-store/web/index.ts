import { tryAsync } from 'wellcrafted/result';
import type { DownloadService } from '$lib/services/download';
import { BlobError, type BlobStore } from '../types';
import { blobToSerializedAudio, WhisperingDatabase } from './dexie-database';
import type { SerializedAudio } from './dexie-schemas';

/**
 * Convert serialized audio back to Blob for use in the application.
 */
function serializedAudioToBlob(serializedAudio: SerializedAudio): Blob {
	return new Blob([serializedAudio.arrayBuffer], {
		type: serializedAudio.blobType,
	});
}

/**
 * Cache for audio object URLs to avoid recreating them.
 * Maps recordingId -> object URL
 */
const audioUrlCache = new Map<string, string>();

export function createBlobStoreWeb({
	DownloadService,
}: {
	DownloadService: DownloadService;
}): BlobStore {
	const db = new WhisperingDatabase({ DownloadService });
	return {
		audio: {
			async save(recordingId, audio) {
				const serializedAudio = await blobToSerializedAudio(audio);
				return tryAsync({
					try: async () => {
						await db.recordings.put({ id: recordingId, serializedAudio });
					},
					catch: (error) => BlobError.MutationFailed({ cause: error }),
				});
			},

			delete: async (idOrIds) => {
				const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
				return tryAsync({
					try: () => db.recordings.bulkDelete(ids),
					catch: (error) => BlobError.MutationFailed({ cause: error }),
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
					catch: (error) => BlobError.QueryFailed({ cause: error }),
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
					catch: (error) => BlobError.QueryFailed({ cause: error }),
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
					catch: (error) => BlobError.MutationFailed({ cause: error }),
				});
			},
		}, // End of audio namespace
	};
}
