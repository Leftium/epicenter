/**
 * ZIP Utilities - ported from vault-core
 *
 * Uses fflate for fast ZIP operations.
 */

import { unzipSync } from 'fflate';

export type ZipNamespace = {
	/** Extract a zip archive into a map of filename→bytes */
	unpack(bytes: Uint8Array): Record<string, Uint8Array>;
};

/**
 * Unpack a ZIP archive.
 * Returns a map of filename → Uint8Array content.
 */
export function unpackZip(bytes: Uint8Array): Record<string, Uint8Array> {
	return unzipSync(bytes);
}

export const ZIP = {
	unpack: unpackZip,
};
