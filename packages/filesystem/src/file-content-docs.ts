/**
 * Per-file content Y.Doc factory. Owns Y.Doc construction + timeline
 * attachment + `updatedAt` writeback; persistence is caller-owned via the
 * `attach` callback. See `buildPerRowDoc` / `DocPersistence` in
 * `@epicenter/document` for the contract.
 */

import {
	attachTimeline,
	buildPerRowDoc,
	defineDocument,
	type DocPersistence,
} from '@epicenter/document';
import type { Table } from '@epicenter/workspace';
import type * as Y from 'yjs';
import type { FileId } from './ids.js';
import type { FileRow } from './table.js';

export function createFileContentDocs({
	workspaceId,
	filesTable,
	attach,
}: {
	workspaceId: string;
	filesTable: Table<FileRow>;
	attach?: (ydoc: Y.Doc) => DocPersistence;
}) {
	return defineDocument((fileId: FileId) => {
		const base = buildPerRowDoc({
			workspaceId,
			collection: 'files',
			field: 'content',
			id: fileId,
			onUpdate: () =>
				filesTable.update(fileId, { updatedAt: Date.now() }),
			attach,
		});
		return { ...base, content: attachTimeline(base.ydoc) };
	});
}

export type FileContentDocs = ReturnType<typeof createFileContentDocs>;
