/**
 * Test helper: OPFS handles over the in-memory stand-in that let a test hold
 * a save while it runs.
 */
import type {
	OpfsDirectoryHandle,
	OpfsFileHandle,
} from '../../../../packages/folder/src/opfs-store.js';

/**
 * OPFS handles that call `beforeClose` with a file's own handle before a
 * stream to it publishes: the window in which a save is running.
 */
export function holdCloses(
	directory: OpfsDirectoryHandle,
	beforeClose: (file: OpfsFileHandle) => Promise<void>,
): OpfsDirectoryHandle {
	const holdFile = (file: OpfsFileHandle): OpfsFileHandle => ({
		kind: 'file',
		name: file.name,
		getFile: () => file.getFile(),
		async createWritable(options) {
			const writable = await file.createWritable(options);
			return {
				write: (data) => writable.write(data),
				abort: (reason) => writable.abort(reason),
				async close() {
					await beforeClose(file);
					return writable.close();
				},
			};
		},
	});
	return {
		kind: 'directory',
		name: directory.name,
		getDirectoryHandle: async (name, options) =>
			holdCloses(await directory.getDirectoryHandle(name, options), beforeClose),
		getFileHandle: async (name, options) =>
			holdFile(await directory.getFileHandle(name, options)),
		removeEntry: (name, options) => directory.removeEntry(name, options),
		async *values() {
			for await (const entry of directory.values())
				yield entry.kind === 'file'
					? holdFile(entry)
					: holdCloses(entry, beforeClose);
		},
	};
}
