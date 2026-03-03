import {
	readDir,
	readFile,
	remove,
	writeFile,
} from '@tauri-apps/plugin-fs';
import type { BlobStore } from './types.js';

const EXTENSION_TO_MIME: Record<string, string> = {
	webm: 'audio/webm',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	mp4: 'audio/mp4',
	m4a: 'audio/mp4',
};

const MIME_TO_EXTENSION: Record<string, string> = {
	'audio/webm': 'webm',
	'audio/mpeg': 'mp3',
	'audio/wav': 'wav',
	'audio/ogg': 'ogg',
	'audio/mp4': 'mp4',
};

function mimeFromExtension(ext: string): string {
	return EXTENSION_TO_MIME[ext] ?? 'application/octet-stream';
}

function extensionFromMime(mimeType: string): string {
	return MIME_TO_EXTENSION[mimeType] ?? 'bin';
}

/**
 * Find all files in `basePath` whose name starts with `{id}.`.
 */
async function findMatchingFiles(
	basePath: string,
	id: string,
): Promise<string[]> {
	const prefix = `${id}.`;
	const entries = await readDir(basePath);
	return entries
		.filter((entry) => entry.name.startsWith(prefix))
		.map((entry) => entry.name);
}

export function createFileSystemBlobStore(basePath: string): BlobStore {
	return {
		async get(id) {
			const matches = await findMatchingFiles(basePath, id);
			if (matches.length === 0) return null;

			const filename = matches[0]!;
			const ext = filename.split('.').pop() ?? '';
			const mimeType = mimeFromExtension(ext);

			const bytes = await readFile(`${basePath}/${filename}`);
			const blob = new Blob([bytes], { type: mimeType });

			return { blob, mimeType };
		},

		async put(id, blob, mimeType) {
			const ext = extensionFromMime(mimeType);
			const arrayBuffer = await blob.arrayBuffer();
			await writeFile(
				`${basePath}/${id}.${ext}`,
				new Uint8Array(arrayBuffer),
			);
		},

		async delete(id) {
			const matches = await findMatchingFiles(basePath, id);
			await Promise.all(
				matches.map((filename) => remove(`${basePath}/${filename}`)),
			);
		},

		async has(id) {
			const matches = await findMatchingFiles(basePath, id);
			return matches.length > 0;
		},
	};
}
