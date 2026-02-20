import type { DocumentBinding } from '@epicenter/hq/static';
import { parseSheetFromCsv } from './sheet-helpers.js';
import { createTimeline } from './timeline-helpers.js';
import type { FileId, FileRow } from './types.js';

/**
 * Content I/O backed by a {@link DocumentBinding}.
 *
 * Thin wrappers around `binding.open()` + timeline for mode-specific
 * operations (binary, sheet, text append) that the binding's built-in
 * `read()`/`write()` don't cover.
 *
 * The Y.Doc lifecycle is managed by the workspace's document binding
 * (automatic cleanup on row deletion, `updatedAt` auto-bump, extension hooks).
 */
export type ContentHelpers = {
	/** Read file content as a string (text, binary-decoded, or sheet CSV). */
	read(fileId: FileId): Promise<string>;
	/** Read file content as a Uint8Array. */
	readBuffer(fileId: FileId): Promise<Uint8Array>;
	/**
	 * Write data to a file, handling mode switching.
	 * Returns the byte size of the written data.
	 */
	write(fileId: FileId, data: string | Uint8Array): Promise<number>;
	/**
	 * Append text to a file's content, handling mode switching.
	 * Returns the new total byte size, or `null` if no entry exists (caller should use write instead).
	 */
	append(fileId: FileId, data: string): Promise<number | null>;
};

/**
 * Create content I/O helpers backed by a document binding.
 *
 * Every method opens the content doc via `binding.open()` (idempotent),
 * then uses the timeline abstraction for mode-aware reads/writes.
 * The binding handles Y.Doc lifecycle, provider wiring, and `updatedAt` bumping.
 *
 * @example
 * ```typescript
 * const helpers = createContentHelpers(ws.tables.files.docs.content);
 * const text = await helpers.read(fileId);
 * const size = await helpers.write(fileId, 'hello');
 * ```
 */
export function createContentHelpers(
	binding: DocumentBinding<FileRow>,
): ContentHelpers {
	return {
		async read(fileId) {
			const ydoc = await binding.open(fileId);
			return createTimeline(ydoc).readAsString();
		},

		async readBuffer(fileId) {
			const ydoc = await binding.open(fileId);
			return createTimeline(ydoc).readAsBuffer();
		},

		async write(fileId, data) {
			const ydoc = await binding.open(fileId);
			const tl = createTimeline(ydoc);

			if (typeof data === 'string') {
				if (tl.currentMode === 'sheet') {
					const columns = tl.currentEntry!.get('columns') as import('yjs').Map<
						import('yjs').Map<string>
					>;
					const rows = tl.currentEntry!.get('rows') as import('yjs').Map<
						import('yjs').Map<string>
					>;
					ydoc.transact(() => {
						columns.forEach((_, key) => {
							columns.delete(key);
						});
						rows.forEach((_, key) => {
							rows.delete(key);
						});
						parseSheetFromCsv(data, columns, rows);
					});
				} else if (tl.currentMode === 'text') {
					const ytext = tl.currentEntry!.get('content') as import('yjs').Text;
					ydoc.transact(() => {
						ytext.delete(0, ytext.length);
						ytext.insert(0, data);
					});
				} else {
					ydoc.transact(() => tl.pushText(data));
				}
				return new TextEncoder().encode(data).byteLength;
			} else {
				ydoc.transact(() => tl.pushBinary(data));
				return data.byteLength;
			}
		},

		async append(fileId, data) {
			const ydoc = await binding.open(fileId);
			const tl = createTimeline(ydoc);

			if (tl.currentMode === 'text') {
				const ytext = tl.currentEntry!.get('content') as import('yjs').Text;
				ydoc.transact(() => ytext.insert(ytext.length, data));
			} else if (tl.currentMode === 'binary') {
				const existing = new TextDecoder().decode(
					tl.currentEntry!.get('content') as Uint8Array,
				);
				ydoc.transact(() => tl.pushText(existing + data));
			} else {
				return null;
			}

			// Re-read after mutation
			const updated = createTimeline(ydoc);
			if (updated.currentMode === 'text') {
				return new TextEncoder().encode(
					(
						updated.currentEntry!.get('content') as import('yjs').Text
					).toString(),
				).byteLength;
			}
			return (updated.currentEntry!.get('content') as Uint8Array).byteLength;
		},
	};
}
