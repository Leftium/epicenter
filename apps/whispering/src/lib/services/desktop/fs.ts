import { basename } from '@tauri-apps/api/path';
import { readFile } from '@tauri-apps/plugin-fs';
import mime from 'mime';
import { defineErrors, extractErrorMessage, type InferErrors } from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';

export const FsError = defineErrors({
	Service: ({ operation, paths, cause }: {
		operation: string;
		paths: string | string[];
		cause: string;
	}) => {
		const pathStr = Array.isArray(paths) ? paths.join(', ') : paths;
		return {
			message: `Failed to ${operation}: ${pathStr}: ${cause}`,
			operation,
			paths,
			cause,
		};
	},
});
export type FsError = InferErrors<typeof FsError>;

export const FsServiceLive = {
	/**
	 * Reads a file from disk and creates a Blob with the correct MIME type.
	 * @param path - The file path to read
	 */
	pathToBlob: (path: string) =>
		tryAsync({
			try: () => createBlobFromPath(path),
			catch: (error) =>
				FsError.Service({
					operation: 'read file as Blob', paths: path, cause: extractErrorMessage(error),
				}),
		}),

	/**
	 * Reads a file from disk and creates a File object with the correct MIME type.
	 * @param path - The file path to read
	 */
	pathToFile: (path: string) =>
		tryAsync({
			try: () => createFileFromPath(path),
			catch: (error) =>
				FsError.Service({
					operation: 'read file as File', paths: path, cause: extractErrorMessage(error),
				}),
		}),

	/**
	 * Reads multiple files from disk and creates File objects with correct MIME types.
	 * @param paths - Array of file paths to read
	 */
	pathsToFiles: (paths: string[]) =>
		tryAsync({
			try: () => Promise.all(paths.map(createFileFromPath)),
			catch: (error) =>
				FsError.Service({
					operation: 'read files',
					paths,
					cause: extractErrorMessage(error),
				}),
		}),
};

export type FsService = typeof FsServiceLive;

/** Reads a file from disk and creates a Blob with the correct MIME type. */
async function createBlobFromPath(path: string): Promise<Blob> {
	const { bytes, mimeType } = await readFileWithMimeType(path);
	return new Blob([bytes], { type: mimeType });
}

/** Reads a file from disk and creates a File object with the correct MIME type. */
async function createFileFromPath(path: string): Promise<File> {
	const { bytes, mimeType } = await readFileWithMimeType(path);
	const fileName = await basename(path);
	return new File([bytes], fileName, { type: mimeType });
}

/**
 * Reads a file and returns its bytes with the correct type for Blob/File constructors,
 * along with the inferred MIME type.
 *
 * Tauri's readFile always returns ArrayBuffer-backed Uint8Array, never SharedArrayBuffer,
 * so the cast is safe.
 */
async function readFileWithMimeType(path: string): Promise<{
	bytes: Uint8Array<ArrayBuffer>;
	mimeType: string;
}> {
	// Cast is safe: Tauri's readFile always returns ArrayBuffer-backed Uint8Array, never SharedArrayBuffer
	const bytes = (await readFile(path)) as Uint8Array<ArrayBuffer>;
	const mimeType = mime.getType(path) ?? 'application/octet-stream';
	return { bytes, mimeType };
}
