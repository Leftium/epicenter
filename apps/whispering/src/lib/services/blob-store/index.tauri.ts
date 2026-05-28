import { Ok } from 'wellcrafted/result';
import { createFileSystemBlobStore } from './file-system.tauri';
import type { BlobStore } from './types';
import { BlobError } from './types';
import { createIndexedDbBlobStore } from './web';

export type { BlobStore } from './types';
export { BlobError } from './types';

/**
 * Tauri blob store with dual-source fallback.
 *
 * Writes go to the file system. Reads check file system first, then fall
 * back to IndexedDB for unmigrated legacy data. Deletes hit both.
 */

const fileSystemDb = createFileSystemBlobStore();
const indexedDb = createIndexedDbBlobStore();

export const AudioBlobStoreLive = {
	save: async (key, blob) => {
		// SINGLE WRITE: only to file system
		return fileSystemDb.save(key, blob);
	},

	delete: async (idOrIds) => {
		const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
		const [fsResult, idbResult] = await Promise.all([
			fileSystemDb.delete(ids),
			indexedDb.delete(ids),
		]);

		if (fsResult.error && idbResult.error) {
			return BlobError.WriteFailed({ cause: fsResult.error });
		}
		return Ok(undefined);
	},

	getBlob: async (key) => {
		// DUAL READ: file system first, fall back to IndexedDB
		const fsResult = await fileSystemDb.getBlob(key);
		if (fsResult.data) return Ok(fsResult.data);

		const idbResult = await indexedDb.getBlob(key);
		if (idbResult.data) return Ok(idbResult.data);

		if (fsResult.error && idbResult.error) {
			return BlobError.ReadFailed({ cause: fsResult.error });
		}

		return BlobError.ReadFailed({
			cause: { message: `blob not found for key "${key}"`, key },
		});
	},

	ensurePlaybackUrl: async (key) => {
		const fsResult = await fileSystemDb.ensurePlaybackUrl(key);
		if (fsResult.data) return Ok(fsResult.data);

		const idbResult = await indexedDb.ensurePlaybackUrl(key);
		if (idbResult.data) return Ok(idbResult.data);

		if (fsResult.error && idbResult.error) {
			return BlobError.ReadFailed({ cause: fsResult.error });
		}

		return BlobError.ReadFailed({
			cause: { message: `blob not found for key "${key}"`, key },
		});
	},

	revokeUrl: (key) => {
		fileSystemDb.revokeUrl(key);
		indexedDb.revokeUrl(key);
	},

	clear: async () => {
		const [fsResult, idbResult] = await Promise.all([
			fileSystemDb.clear(),
			indexedDb.clear(),
		]);

		if (fsResult.error && idbResult.error) {
			return BlobError.WriteFailed({ cause: fsResult.error });
		}
		return Ok(undefined);
	},
} satisfies BlobStore;
