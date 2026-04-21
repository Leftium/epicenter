/**
 * File content documents — per-file Y.Doc factory for the filesystem package.
 *
 * Because the filesystem package is shared between apps, the factory takes
 * the host workspace as a parameter — each app constructs its own factory
 * bound to its own workspace instance. Apps call `createFileContentDocs(ws)`
 * once and retain the result for the workspace lifetime.
 *
 * Apps opt into IndexedDB persistence via `{ persistence: 'indexeddb' }`
 * (default). In Node tests or environments without IDB, pass `persistence:
 * 'none'` to skip the attachment.
 *
 * NOTE: Sync is deferred to a follow-up. The framework-collapse spec
 * (20260420T230100) lands IDB-only in the first pass and threads sync
 * config through in a later pass.
 */

import {
	attachIndexedDb,
	attachTimeline,
	defineDocument,
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
 * @param filesTable - the workspace's files table helper. Used for the
 *                     `onLocalUpdate` writeback that bumps `updatedAt`.
 * @param workspaceId - optional workspace identifier, used to scope the
 *                      Y.Doc guid so two workspaces never collide.
 * @param opts.persistence - `'indexeddb'` (default) to attach IDB; `'none'` to skip.
 */
export function createFileContentDocs(
	filesTable: Table<FileRow>,
	workspaceId = 'filesystem',
	opts: { persistence?: PersistenceMode } = {},
) {
	const persistence = opts.persistence ?? 'indexeddb';

	function buildFileContentDoc(fileId: FileId) {
		const ydoc = new Y.Doc({
			guid: `${workspaceId}.files.${fileId}.content`,
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
