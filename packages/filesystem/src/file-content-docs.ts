/**
 * Per-file content Y.Doc factory. Apps call `createFileContentDocs({
 * workspaceId, filesTable, attach })` once per workspace and retain the
 * result for its lifetime.
 *
 * The factory owns Y.Doc construction + timeline attachment + `updatedAt`
 * writeback. Persistence is caller-owned via the `attach` callback —
 *
 *   attach: (ydoc) => attachIndexedDb(ydoc)          // browser
 *   attach: (ydoc) => attachSqlite(ydoc, { filePath })  // desktop/CLI
 *   // omit for in-memory (tests, Node stubs)
 *
 * The callback's return value is threaded: `whenLoaded` surfaces on
 * `handle.whenReady`, `whenDisposed` feeds the cache teardown.
 */

import {
	attachTimeline,
	defineDocument,
	docGuid,
	onLocalUpdate,
} from '@epicenter/document';
import type { Table } from '@epicenter/workspace';
import * as Y from 'yjs';
import type { FileId } from './ids.js';
import type { FileRow } from './table.js';

export type ContentAttachment = {
	whenLoaded?: Promise<void>;
	whenDisposed?: Promise<void>;
};

export function createFileContentDocs({
	workspaceId,
	filesTable,
	attach,
}: {
	workspaceId: string;
	filesTable: Table<FileRow>;
	attach?: (ydoc: Y.Doc) => ContentAttachment | void;
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

		onLocalUpdate(ydoc, () => {
			filesTable.update(fileId, { updatedAt: Date.now() });
		});

		const attached = attach?.(ydoc);

		return {
			ydoc,
			content,
			whenReady: attached?.whenLoaded ?? Promise.resolve(),
			whenDisposed: attached?.whenDisposed ?? Promise.resolve(),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});
}

export type FileContentDocs = ReturnType<typeof createFileContentDocs>;
