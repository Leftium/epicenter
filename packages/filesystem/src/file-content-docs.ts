/**
 * File content documents — per-file Y.Doc factory for the filesystem package.
 *
 * Because the filesystem package is shared between apps, the factory takes
 * the host workspace's id and files table as inputs — each app constructs
 * its own factory bound to its own workspace instance. Apps call
 * `createFileContentDocs({ workspaceId, filesTable })` once and retain the
 * result for the workspace lifetime.
 *
 * Apps opt into IndexedDB persistence via `persistence: 'indexeddb'`
 * (default). In Node tests or environments without IDB, pass
 * `persistence: 'none'` to skip the attachment.
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

type PersistenceMode = 'indexeddb' | 'none';

/**
 * Create a per-workspace file-content document factory.
 *
 * @param workspaceId - the host workspace's id, used as the first segment of
 *   the Y.Doc guid. Required — no default — because a shared default would
 *   collapse IndexedDB namespaces across apps that both import this package.
 * @param filesTable - the workspace's files table helper. Used for the
 *   `onLocalUpdate` writeback that bumps `updatedAt`.
 * @param persistence - `'indexeddb'` (default) to attach IDB; `'none'` to skip.
 */
export function createFileContentDocs({
	workspaceId,
	filesTable,
	persistence = 'indexeddb',
}: {
	workspaceId: string;
	filesTable: Table<FileRow>;
	persistence?: PersistenceMode;
}) {
	function buildFileContentDoc(fileId: FileId) {
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
	}

	return defineDocument(buildFileContentDoc, { gcTime: 30_000 });
}

export type FileContentDocs = ReturnType<typeof createFileContentDocs>;
