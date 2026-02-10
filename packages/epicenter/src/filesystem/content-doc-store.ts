import * as Y from 'yjs';
import type { ContentDocStore, DocumentHandle, FileId } from './types.js';
import {
	serializeMarkdownWithFrontmatter,
	serializeXmlFragmentToMarkdown,
	yMapToRecord,
} from './markdown-helpers.js';
import { getExtensionCategory } from './convert-on-switch.js';

/**
 * Open a Y.Doc and return the appropriate handle based on file extension.
 * .md files use Y.XmlFragment('richtext') + Y.Map('frontmatter').
 * All other files use Y.Text('text').
 */
export function openDocument(fileId: FileId, fileName: string, ydoc: Y.Doc): DocumentHandle {
	if (getExtensionCategory(fileName) === 'richtext') {
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
