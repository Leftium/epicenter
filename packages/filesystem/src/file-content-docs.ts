/**
 * Per-file content Y.Doc factory. Apps call `createFileContentDocs({
 * workspaceId, filesTable, attachPersistence })` once per workspace and retain
 * the result for its lifetime.
 *
 * The factory owns Y.Doc construction + timeline attachment + `updatedAt`
 * writeback. Persistence is caller-owned via the `attachPersistence` callback —
 *
 *   // browser
 *   attachPersistence: (ydoc) => attachIndexedDb(ydoc),
 *
 *   // desktop / CLI — caller closes over a directory
 *   attachPersistence: (ydoc) => attachSqlite(ydoc, {
 *     filePath: join(contentDir, `${ydoc.guid}.db`),
 *   }),
 *
 *   // omit for in-memory (tests, Node stubs)
 *
 * The callback's return value is threaded: `whenLoaded` surfaces on
 * `handle.whenReady`, `whenDisposed` feeds the cache teardown.
 */

import {
	attachTimeline,
	createPerRowDoc,
	defineDocument,
	type DocPersistence,
} from '@epicenter/workspace';
import type { Table } from '@epicenter/workspace';
import type * as Y from 'yjs';
import type { FileId } from './ids.js';
import type { FileRow } from './table.js';

export function createFileContentDocs({
	workspaceId,
	filesTable,
	attachPersistence,
}: {
	workspaceId: string;
	filesTable: Table<FileRow>;
	attachPersistence?: (ydoc: Y.Doc) => DocPersistence;
}) {
	return defineDocument((fileId: FileId) => {
		const base = createPerRowDoc({
			workspaceId,
			collection: 'files',
			field: 'content',
			id: fileId,
			onUpdate: () =>
				filesTable.update(fileId, { updatedAt: Date.now() }),
			attach: attachPersistence,
		});
		return { ...base, content: attachTimeline(base.ydoc) };
	});
}

export type FileContentDocs = ReturnType<typeof createFileContentDocs>;
