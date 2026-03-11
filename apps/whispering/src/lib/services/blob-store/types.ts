/**
 * Platform-agnostic blob storage interface.
 *
 * Audio files stay local — they never enter the Yjs CRDT layer.
 * Both desktop (filesystem) and web (IndexedDB) implement this interface.
 * The rest of the app calls `blobStore.get(recordingId)` without knowing
 * which backend is in use.
 */
export type BlobStore = {
	get(id: string): Promise<{ blob: Blob; mimeType: string } | null>;
	put(id: string, blob: Blob, mimeType: string): Promise<void>;
	delete(id: string): Promise<void>;
	has(id: string): Promise<boolean>;
};
