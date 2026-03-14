import { type Documents, parseSheetFromCsv } from '@epicenter/workspace';
import type { FileId } from '../ids.js';
import type { FileRow } from '../table.js';

/**
 * Content I/O backed by a {@link Documents}.
 *
 * Thin wrappers around `documents.open()` + `handle.content` for mode-specific
 * operations (sheet, text append) that the built-in
 * `handle.content.read()`/`handle.content.write()` don't cover.
 *
 * The Y.Doc lifecycle is managed by the workspace's documents manager
 * (automatic cleanup on row deletion, `updatedAt` auto-bump, extension hooks).
 */
export type ContentHelpers = {
	/** Read file content as a string (text or sheet CSV). */
	read(fileId: FileId): Promise<string>;
	/**
	 * Write text data to a file, handling mode switching.
	 * Returns the byte size of the written data.
	 */
	write(fileId: FileId, data: string): Promise<number>;
	/**
	 * Append text to a file's content, handling mode switching.
	 * Returns the new total byte size, or `null` if no entry exists (caller should use write instead).
	 */
	append(fileId: FileId, data: string): Promise<number | null>;
};

/**
 * Create content I/O helpers backed by a documents instance.
 *
 * Every method opens the content doc via `documents.open()` (idempotent),
 * then delegates to `handle.content` for timeline-backed reads/writes.
 * Advanced operations (sheet mode switching, append) use
 * `handle.content.timeline` directly.
 *
 * @example
 * ```typescript
 * const helpers = createContentHelpers(ws.documents.files.content);
 * const text = await helpers.read(fileId);
 * const size = await helpers.write(fileId, 'hello');
 * ```
 */
export function createContentHelpers(
	documents: Documents<FileRow>,
): ContentHelpers {
	return {
		async read(fileId) {
			const handle = await documents.open(fileId);
			return handle.content.read();
		},

		async write(fileId, data) {
			const handle = await documents.open(fileId);
			const tl = handle.content.timeline;

			if (tl.currentMode === 'sheet') {
				const columns = tl.currentEntry?.get('columns') as import('yjs').Map<
					import('yjs').Map<string>
				>;
				const rows = tl.currentEntry?.get('rows') as import('yjs').Map<
					import('yjs').Map<string>
				>;
				handle.ydoc.transact(() => {
					columns.forEach((_, key) => {
						columns.delete(key);
					});
					rows.forEach((_, key) => {
						rows.delete(key);
					});
					parseSheetFromCsv(data, columns, rows);
				});
			} else {
				handle.content.write(data);
			}
			return new TextEncoder().encode(data).byteLength;
		},

		async append(fileId, data) {
			const handle = await documents.open(fileId);
			const tl = handle.content.timeline;

			if (tl.currentMode === 'text') {
				const ytext = tl.currentEntry?.get('content') as import('yjs').Text;
				handle.ydoc.transact(() => ytext.insert(ytext.length, data));
			} else {
				return null;
			}

			// Re-read after mutation
			return new TextEncoder().encode(
				(tl.currentEntry?.get('content') as import('yjs').Text).toString(),
			).byteLength;
		},
	};
}
