import { convertFileSrc } from '@tauri-apps/api/core';
import {
	exists,
	mkdir,
	readDir,
	writeFile as tauriWriteFile,
} from '@tauri-apps/plugin-fs';
import mime from 'mime';
import { tryAsync } from 'wellcrafted/result';
import { PATHS } from '$lib/constants/paths';
import { requireTauri } from '$lib/tauri';
import { commands } from '$lib/tauri/commands';
import { BlobError, type BlobStore } from './types';

/**
 * File system-based blob store implementation for desktop.
 * Stores audio files on the Tauri filesystem.
 *
 * Directory structure:
 * - recordings/
 *   - {id}.{ext} (audio file: .wav, .opus, .mp3, etc.)
 *   - {id}.md (metadata materialized by workspace, NOT written by this service)
 */
export function createFileSystemBlobStore() {
	return {
		async save(key, blob) {
			return tryAsync({
				try: async () => {
					const recordingsPath = await PATHS.DB.RECORDINGS();
					await mkdir(recordingsPath, { recursive: true });

					const extension = mime.getExtension(blob.type) ?? 'bin';
					const audioPath = await PATHS.DB.RECORDING_AUDIO(key, extension);
					const arrayBuffer = await blob.arrayBuffer();
					await tauriWriteFile(audioPath, new Uint8Array(arrayBuffer));
				},
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},

		async delete(idOrIds) {
			const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
			return tryAsync({
				try: async () => {
					const recordingsPath = await PATHS.DB.RECORDINGS();
					const idsToDelete = new Set(ids);
					const allFiles = await readDir(recordingsPath);
					const filenames = allFiles
						.filter((file) => {
							const id = file.name.split('.')[0] ?? '';
							return idsToDelete.has(id);
						})
						.map((file) => file.name);
					const { error } = await commands.deleteRecordingFiles(filenames);
					if (error !== null) throw error;
				},
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},

		async getBlob(key: string) {
			return tryAsync({
				try: async () => {
					const recordingsPath = await PATHS.DB.RECORDINGS();
					const audioFilename = await findAudioFile(recordingsPath, key);

					if (!audioFilename) {
						throw new Error(`Audio file not found for key ${key}`);
					}

					const audioPath = await PATHS.DB.RECORDING_FILE(audioFilename);

					// Use existing fsService.pathToBlob utility
					const { data: blob, error } =
						await requireTauri().fs.pathToBlob(audioPath);
					if (error) throw error;

					return blob;
				},
				catch: (error) => BlobError.ReadFailed({ cause: error }),
			});
		},

		async ensurePlaybackUrl(key: string) {
			return tryAsync({
				try: async () => {
					const recordingsPath = await PATHS.DB.RECORDINGS();
					const audioFilename = await findAudioFile(recordingsPath, key);

					if (!audioFilename) {
						throw new Error(`Audio file not found for key ${key}`);
					}

					const audioPath = await PATHS.DB.RECORDING_FILE(audioFilename);
					const assetUrl = convertFileSrc(audioPath);

					// Return the URL as-is from convertFileSrc()
					// The Tauri backend handles URL decoding automatically
					return assetUrl;
				},
				catch: (error) => BlobError.ReadFailed({ cause: error }),
			});
		},

		revokeUrl(_key: string) {
			// No-op on desktop, URLs are asset:// protocol managed by Tauri
		},

		async clear() {
			return tryAsync({
				try: async () => {
					const recordingsPath = await PATHS.DB.RECORDINGS();
					const dirExists = await exists(recordingsPath);
					if (!dirExists) return undefined;

					const allFiles = await readDir(recordingsPath);
					const filenames = allFiles.map((file) => file.name);
					const { error } = await commands.deleteRecordingFiles(filenames);
					if (error !== null) throw error;
				},
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},
	} satisfies BlobStore;
}

/**
 * Helper function to find audio file by ID.
 * Reads directory once and finds the matching file by ID prefix.
 * This is much faster than checking every possible extension.
 */
async function findAudioFile(dir: string, id: string): Promise<string | null> {
	const files = await readDir(dir);
	const audioFile = files.find(
		(f) => f.name.startsWith(`${id}.`) && !f.name.endsWith('.md'),
	);
	return audioFile?.name ?? null;
}
