import * as Y from 'yjs';
import type { ContentDocPool, DocumentHandle } from './types.js';
import {
	serializeMarkdownWithFrontmatter,
	serializeXmlFragmentToMarkdown,
	yMapToRecord,
} from './markdown-helpers.js';

type PoolEntry = {
	handle: DocumentHandle;
	refcount: number;
	provider?: { destroy(): void };
};

/**
 * Open a Y.Doc and return the appropriate handle based on file extension.
 * .md files use Y.XmlFragment('richtext') + Y.Map('frontmatter').
 * All other files use Y.Text('text').
 */
export function openDocument(fileId: string, fileName: string, ydoc: Y.Doc): DocumentHandle {
	if (fileName.endsWith('.md')) {
		return {
			type: 'richtext',
			fileId,
			ydoc,
			content: ydoc.getXmlFragment('richtext'),
			frontmatter: ydoc.getMap('frontmatter'),
		};
	}
	return {
		type: 'text',
		fileId,
		ydoc,
		content: ydoc.getText('text'),
	};
}

/** Serialize a DocumentHandle to a plain string */
export function documentHandleToString(handle: DocumentHandle): string {
	if (handle.type === 'text') {
		return handle.content.toString();
	}
	const frontmatter = yMapToRecord(handle.frontmatter);
	const body = serializeXmlFragmentToMarkdown(handle.content);
	return serializeMarkdownWithFrontmatter(frontmatter, body);
}

/**
 * Create a reference-counted content doc pool.
 * Content Y.Docs are created on demand and destroyed when no longer referenced.
 */
export function createContentDocPool(
	connectProvider?: (ydoc: Y.Doc) => { destroy(): void },
): ContentDocPool {
	const docs = new Map<string, PoolEntry>();

	return {
		acquire(fileId: string, fileName: string): DocumentHandle {
			const existing = docs.get(fileId);
			if (existing) {
				existing.refcount++;
				return existing.handle;
			}

			const ydoc = new Y.Doc({ guid: fileId, gc: false });
			const provider = connectProvider?.(ydoc);
			const handle = openDocument(fileId, fileName, ydoc);
			docs.set(fileId, { handle, refcount: 1, provider });
			return handle;
		},

		release(fileId: string): void {
			const entry = docs.get(fileId);
			if (!entry) return;
			entry.refcount--;
			if (entry.refcount <= 0) {
				entry.provider?.destroy();
				entry.handle.ydoc.destroy();
				docs.delete(fileId);
			}
		},

		peek(fileId: string): DocumentHandle | undefined {
			return docs.get(fileId)?.handle;
		},

		loadAndCache(fileId: string, fileName: string): string {
			const handle = this.acquire(fileId, fileName);
			const text = documentHandleToString(handle);
			this.release(fileId);
			return text;
		},
	};
}
