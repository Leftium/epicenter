import { Ok } from 'wellcrafted/result';
import type { DownloadService } from '$lib/services/download';
import { createFileSystemDbService } from './file-system';
import type { DbService } from './types';
import { DbError } from './types';
import { createDbServiceWeb } from './web';


/**
 * Desktop DB Service — audio blob store with dual-source fallback.
 *
 * Recording metadata lives in the workspace (Yjs CRDT). The DB service
 * only manages audio blobs. Audio reads check file system first, then
 * fall back to IndexedDB for unmigrated data.
 *
 * Transformations and runs still use the dual read/single write pattern
 * during their migration period.
 */

export function createDbServiceDesktop({
	DownloadService,
}: {
	DownloadService: DownloadService;
}): DbService {
	const fileSystemDb = createFileSystemDbService();
	const indexedDb = createDbServiceWeb({ DownloadService });

	return {
		audio: {
			save: async (recordingId, audio) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.audio.save(recordingId, audio);
			},

			delete: async (idOrIds) => {
				const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
				// Delete from BOTH sources to ensure complete removal
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.audio.delete(ids),
					indexedDb.audio.delete(ids),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return DbError.MutationFailed({ cause: fsResult.error });
				}

				// Success if at least one succeeded
				return Ok(undefined);
			},


			getBlob: async (recordingId) => {
				// DUAL READ: Check file system first, fallback to IndexedDB
				const fsResult =
					await fileSystemDb.audio.getBlob(recordingId);

				// If found in file system, return it
				if (fsResult.data) {
					return Ok(fsResult.data);
				}

				// Not in file system, check IndexedDB
				const idbResult = await indexedDb.audio.getBlob(recordingId);

				// If found in IndexedDB, return it
				if (idbResult.data) {
					return Ok(idbResult.data);
				}

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return DbError.QueryFailed({ cause: fsResult.error });
				}

				// Not found in either source (but no errors)
				throw new Error(`Audio not found for recording ${recordingId}`);
			},

			ensurePlaybackUrl: async (recordingId) => {
				// DUAL READ: Check file system first, fallback to IndexedDB
				const fsResult =
					await fileSystemDb.audio.ensurePlaybackUrl(recordingId);

				// If found in file system, return it
				if (fsResult.data) {
					return Ok(fsResult.data);
				}

				// Not in file system, check IndexedDB
				const idbResult =
					await indexedDb.audio.ensurePlaybackUrl(recordingId);

				// If found in IndexedDB, return it
				if (idbResult.data) {
					return Ok(idbResult.data);
				}

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return DbError.QueryFailed({ cause: fsResult.error });
				}

				// Not found in either source (but no errors)
				throw new Error(`Audio not found for recording ${recordingId}`);
			},

			revokeUrl: (recordingId) => {
				// Revoke from BOTH sources
				fileSystemDb.audio.revokeUrl(recordingId);
				indexedDb.audio.revokeUrl(recordingId);
			},

			clear: async () => {
				// Clear from BOTH sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.audio.clear(),
					indexedDb.audio.clear(),
				]);

				// Return error only if both failed
				if (fsResult.error && idbResult.error) {
					return DbError.MutationFailed({ cause: fsResult.error });
				}

				return Ok(undefined);
			},
		},

		transformations: {
			getAll: async () => {
				// DUAL READ: Merge from both sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.transformations.getAll(),
					indexedDb.transformations.getAll(),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return DbError.QueryFailed({ cause: fsResult.error });
				}

				// Use data from successful sources (empty array for failed ones)
				const fsTransformations = fsResult.data ?? [];
				const idbTransformations = idbResult.data ?? [];

				// Merge, preferring file system (newer) over IndexedDB
				const merged = new Map();

				for (const t of idbTransformations) {
					merged.set(t.id, t);
				}

				for (const t of fsTransformations) {
					merged.set(t.id, t);
				}

				return Ok(Array.from(merged.values()));
			},

			getById: async (id: string) => {
				// DUAL READ: Check file system first, fallback to IndexedDB
				const fsResult = await fileSystemDb.transformations.getById(id);

				// If found in file system, return it
				if (fsResult.data) {
					return Ok(fsResult.data);
				}

				// Not in file system, check IndexedDB
				const idbResult = await indexedDb.transformations.getById(id);

				// If found in IndexedDB, return it
				if (idbResult.data) {
					return Ok(idbResult.data);
				}

				// If both failed, return an error only if both actually errored
				if (fsResult.error && idbResult.error) {
					return DbError.QueryFailed({ cause: fsResult.error });
				}

				// Not found in either source (but no errors)
				return Ok(null);
			},

			create: async (transformationOrTransformations) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.transformations.create(
					transformationOrTransformations,
				);
			},

			update: async (transformation) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.transformations.update(transformation);
			},

			delete: async (transformationOrTransformations) => {
				// Delete from BOTH sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.transformations.delete(transformationOrTransformations),
					indexedDb.transformations.delete(transformationOrTransformations),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return DbError.MutationFailed({ cause: fsResult.error });
				}

				// Success if at least one succeeded
				return Ok(undefined);
			},

			clear: async () => {
				// Clear from BOTH sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.transformations.clear(),
					indexedDb.transformations.clear(),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return DbError.MutationFailed({ cause: fsResult.error });
				}

				// Success if at least one succeeded
				return Ok(undefined);
			},

			getCount: async () => {
				// DUAL READ: Sum both sources to avoid missing unmigrated IndexedDB data
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.transformations.getCount(),
					indexedDb.transformations.getCount(),
				]);

				if (fsResult.error && idbResult.error) {
					return DbError.QueryFailed({ cause: fsResult.error });
				}

				return Ok((fsResult.data ?? 0) + (idbResult.data ?? 0));
			},
		},

		runs: {
			getAll: async () => {
				// DUAL READ: Merge from both sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.runs.getAll(),
					indexedDb.runs.getAll(),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return DbError.QueryFailed({ cause: fsResult.error });
				}

				// Use data from successful sources (empty array for failed ones)
				const fsRuns = fsResult.data ?? [];
				const idbRuns = idbResult.data ?? [];

				// Merge, preferring file system
				const merged = new Map();
				for (const run of fsRuns) {
					merged.set(run.id, run);
				}
				for (const run of idbRuns) {
					if (!merged.has(run.id)) {
						merged.set(run.id, run);
					}
				}

				return Ok(Array.from(merged.values()));
			},

			getById: async (id: string) => {
				// DUAL READ: Check file system first, fallback to IndexedDB
				const fsResult = await fileSystemDb.runs.getById(id);

				// If found in file system, return it
				if (fsResult.data) {
					return Ok(fsResult.data);
				}

				// Not in file system, check IndexedDB
				const idbResult = await indexedDb.runs.getById(id);

				// If found in IndexedDB, return it
				if (idbResult.data) {
					return Ok(idbResult.data);
				}

				// If both failed, return an error only if both actually errored
				if (fsResult.error && idbResult.error) {
					return DbError.QueryFailed({ cause: fsResult.error });
				}

				// Not found in either source (but no errors)
				return Ok(null);
			},

			getByTransformationId: async (transformationId: string) => {
				// DUAL READ: Merge from both sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.runs.getByTransformationId(transformationId),
					indexedDb.runs.getByTransformationId(transformationId),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return DbError.QueryFailed({ cause: fsResult.error });
				}

				// Use data from successful sources (empty array for failed ones)
				const fsRuns = fsResult.data ?? [];
				const idbRuns = idbResult.data ?? [];

				// Merge, preferring file system
				const merged = new Map();

				for (const run of idbRuns) {
					merged.set(run.id, run);
				}

				for (const run of fsRuns) {
					merged.set(run.id, run);
				}

				// Convert back to array and sort by startedAt (newest first)
				const result = Array.from(merged.values());
				result.sort(
					(a, b) =>
						new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
				);

				return Ok(result);
			},

			getByRecordingId: async (recordingId: string) => {
				// DUAL READ: Merge from both sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.runs.getByRecordingId(recordingId),
					indexedDb.runs.getByRecordingId(recordingId),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return DbError.QueryFailed({ cause: fsResult.error });
				}

				// Use data from successful sources (empty array for failed ones)
				const fsRuns = fsResult.data ?? [];
				const idbRuns = idbResult.data ?? [];

				// Merge, preferring file system
				const merged = new Map();

				for (const run of idbRuns) {
					merged.set(run.id, run);
				}

				for (const run of fsRuns) {
					merged.set(run.id, run);
				}

				// Convert back to array and sort by startedAt (newest first)
				const result = Array.from(merged.values());
				result.sort(
					(a, b) =>
						new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
				);

				return Ok(result);
			},

			create: async (runOrRuns) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.runs.create(runOrRuns);
			},

			addStep: async (run, step) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.runs.addStep(run, step);
			},

			failStep: async (run, stepRunId, error) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.runs.failStep(run, stepRunId, error);
			},

			completeStep: async (run, stepRunId, output) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.runs.completeStep(run, stepRunId, output);
			},

			complete: async (run, output) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.runs.complete(run, output);
			},

			delete: async (runOrRuns) => {
				// Delete from BOTH sources to ensure complete removal
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.runs.delete(runOrRuns),
					indexedDb.runs.delete(runOrRuns),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return DbError.MutationFailed({ cause: fsResult.error });
				}

				// Success if at least one succeeded
				return Ok(undefined);
			},

			clear: async () => {
				// Clear from BOTH sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.runs.clear(),
					indexedDb.runs.clear(),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return DbError.MutationFailed({ cause: fsResult.error });
				}

				// Success if at least one succeeded
				return Ok(undefined);
			},

			getCount: async () => {
				// DUAL READ: Sum both sources to avoid missing unmigrated IndexedDB data
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.runs.getCount(),
					indexedDb.runs.getCount(),
				]);

				if (fsResult.error && idbResult.error) {
					return DbError.QueryFailed({ cause: fsResult.error });
				}

				return Ok((fsResult.data ?? 0) + (idbResult.data ?? 0));
			},
		},
	};
}
