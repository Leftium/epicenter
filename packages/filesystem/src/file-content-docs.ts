/**
 * Per-file content Y.Doc factory. Apps call `createFileContentDocs(workspace)`
 * once per workspace and retain the result for its lifetime. Pass
 * `persistence: 'none'` to skip IndexedDB (Node tests, environments without IDB).
 */

import {
	attachIndexedDb,
	attachTimeline,
	defineDocument,
	docGuid,
	onLocalUpdate,
} from '@epicenter/document';
import type { Table } from '@epicenter/workspace';
import * as Y from 'yjs';
import type { FileId } from './ids.js';
import type { FileRow } from './table.js';

/**
 * @param workspace - host workspace; `{ id, tables.files }` structural shape.
 *   The id becomes the first GUID segment; a shared default would collapse
 *   IDB namespaces across apps that both import this package.
 * @param opts.persistence - `'indexeddb'` (default) or `'none'`.
 */
export function createFileContentDocs(
	workspace: { id: string; tables: { files: Table<FileRow> } },
	{ persistence = 'indexeddb' }: { persistence?: 'indexeddb' | 'none' } = {},
) {
	const filesTable = workspace.tables.files;
	return defineDocument((fileId: FileId) => {
		const ydoc = new Y.Doc({
			guid: docGuid({
				workspaceId: workspace.id,
				collection: 'files',
				rowId: fileId,
				field: 'content',
			}),
			gc: false,
		});
		const content = attachTimeline(ydoc);
		const idb = persistence === 'indexeddb' ? attachIndexedDb(ydoc) : null;

		onLocalUpdate(ydoc, () => {
			filesTable.update(fileId, { updatedAt: Date.now() });
		});

		return {
			ydoc,
			content,
			idb,
			whenReady: idb ? idb.whenLoaded : Promise.resolve(),
			whenDisposed: idb ? idb.whenDisposed : Promise.resolve(),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});
}

export type FileContentDocs = ReturnType<typeof createFileContentDocs>;
