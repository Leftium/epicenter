/**
 * Per-file content Y.Doc factory. Apps call `createFileContentDocs({ workspaceId, filesTable })`
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
 * @param workspaceId - Caller's workspace identity; becomes the first GUID
 *   segment. Required — a shared default would collapse IDB namespaces across
 *   apps that both import this package.
 * @param filesTable - The files table this factory writes back to (bumps
 *   `updatedAt` on local edits).
 * @param persistence - `'indexeddb'` (default) or `'none'`.
 */
export function createFileContentDocs({
	workspaceId,
	filesTable,
	persistence = 'indexeddb',
}: {
	workspaceId: string;
	filesTable: Table<FileRow>;
	persistence?: 'indexeddb' | 'none';
}) {
	return defineDocument((fileId: FileId) => {
		const ydoc = new Y.Doc({
			guid: docGuid({
				workspaceId,
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
