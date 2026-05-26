import type { BlobStore } from './types';
import { createIndexedDbBlobStore } from './web';

export type { BlobStore } from './types';
export { BlobError } from './types';

/**
 * Web blob store: just IndexedDB (via Dexie).
 *
 * On Tauri this is replaced by `index.tauri.ts`, which combines a file
 * system store with the IndexedDB store as a legacy fallback. Both entries
 * expose `AudioBlobStoreLive` satisfying `BlobStore` from types.ts.
 */
export const AudioBlobStoreLive =
	createIndexedDbBlobStore() satisfies BlobStore;
