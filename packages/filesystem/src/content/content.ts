import type { FileId } from '../ids.js';

/**
 * Content I/O shape for filesystem operations.
 *
 * Implemented inline in `file-system.ts` using document handles directly.
 * This type defines the contract for content read/write operations that
 * support text, sheet, and append modes.
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
