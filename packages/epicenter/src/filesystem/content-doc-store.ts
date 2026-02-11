import * as Y from 'yjs';
import type { ContentDocStore, FileId } from './types.js';

/** Create a content doc store — a simple Y.Doc lifecycle manager keyed by FileId. */
export function createContentDocStore(): ContentDocStore {
	const docs = new Map<FileId, Y.Doc>();

	return {
		ensure(fileId: FileId): Y.Doc {
			const existing = docs.get(fileId);
			if (existing) return existing;

			const ydoc = new Y.Doc({ guid: fileId, gc: false });
			docs.set(fileId, ydoc);
			return ydoc;
		},

		destroy(fileId: FileId): void {
			const ydoc = docs.get(fileId);
			if (!ydoc) return;
			ydoc.destroy();
			docs.delete(fileId);
		},

		destroyAll(): void {
			for (const ydoc of docs.values()) {
				ydoc.destroy();
			}
			docs.clear();
		},
	};
}
