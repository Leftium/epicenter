/**
 * Per-file content Y.Doc builder. Pure: takes a `fileId` plus all the deps
 * the construction needs and returns a Disposable bundle. The builder owns
 * Y.Doc construction + timeline attachment + `updatedAt` writeback;
 * persistence is caller-owned via the `attachPersistence` callback:
 *
 *   // browser
 *   attachPersistence: (ydoc) => attachIndexedDb(ydoc),
 *
 *   // desktop / CLI: caller closes over a directory
 *   attachPersistence: (ydoc) => attachSqlite(ydoc, {
 *     filePath: join(contentDir, `${ydoc.guid}.db`),
 *   }),
 *
 *   // omit for in-memory (tests, Node stubs)
 *
 * The callback's return value is threaded: `whenLoaded` surfaces on
 * `whenReady`, `whenDisposed` is available on the persistence handle for
 * teardown barriers.
 *
 * The live document is browser-agnostic on purpose: it has no `sync`
 * field. Browser apps wrap it through `createFileContentDocSource` to
 * satisfy the `BrowserDocInstance` contract; non-browser callers (daemon,
 * CLI, e2e scripts) compose this directly with `createDisposableCache`.
 */

import type {
	BrowserDocPersistence,
	BrowserDocSource,
	DisposableCache,
	Table,
} from '@epicenter/workspace';
import {
	attachTimeline,
	type DocPersistence,
	docGuid,
	onLocalUpdate,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import type { FileId } from './ids.js';
import type { FileRow } from './table.js';

export type FileContentDoc = {
	ydoc: Y.Doc;
	content: ReturnType<typeof attachTimeline>;
	persistence: DocPersistence | undefined;
	whenReady: Promise<unknown>;
	[Symbol.dispose](): void;
};

/**
 * Browser-context view of a `FileContentDoc`: adds the `sync: null`
 * field required by `BrowserDocInstance` (file content is local-only, no
 * remote sync) and narrows `persistence` to `BrowserDocPersistence` so
 * direct consumers can call `clearLocal()` on it.
 */
export type BrowserFileContentDocInstance = FileContentDoc & {
	persistence: BrowserDocPersistence | undefined;
	sync: null;
};

export function fileContentDocGuid({
	workspaceId,
	fileId,
}: {
	workspaceId: string;
	fileId: FileId;
}): string {
	return docGuid({
		workspaceId,
		collection: 'files',
		rowId: fileId,
		field: 'content',
	});
}

/**
 * Cross-package alias for the cache that holds opened FileContentDoc
 * handles. Exported so consumers (the filesystem ops layer, sqlite-index
 * extension, e2e configs) can declare a single shared type instead of
 * spelling out `DisposableCache<FileId, FileContentDoc>` at every site.
 */
export type FileContentDocCache = DisposableCache<FileId, FileContentDoc>;

export function createFileContentDoc({
	fileId,
	workspaceId,
	filesTable,
	attachPersistence,
}: {
	fileId: FileId;
	workspaceId: string;
	filesTable: Table<FileRow>;
	attachPersistence?: (ydoc: Y.Doc) => DocPersistence;
}): FileContentDoc {
	const ydoc = new Y.Doc({
		guid: fileContentDocGuid({ workspaceId, fileId }),
		gc: false,
	});
	onLocalUpdate(ydoc, () =>
		filesTable.update(fileId, { updatedAt: Date.now() }),
	);
	const persistence = attachPersistence?.(ydoc);
	return {
		ydoc,
		content: attachTimeline(ydoc),
		persistence,
		whenReady: persistence?.whenLoaded ?? Promise.resolve(),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

/**
 * Browser-only document source that wraps `createFileContentDoc` to satisfy
 * the `BrowserDocInstance` contract. The source owns id enumeration, doc
 * construction, and by-guid storage cleanup; the cache consumes it
 * directly.
 *
 * `attachPersistence` and `clearLocalDataForGuid` are injected so this
 * package never imports `y-indexeddb`. Browser apps pass
 * `attachIndexedDb` and `clearDocument` (from `y-indexeddb`).
 */
export function createFileContentDocSource({
	workspaceId,
	filesTable,
	attachPersistence,
	clearLocalDataForGuid,
}: {
	workspaceId: string;
	filesTable: Table<FileRow>;
	attachPersistence: (ydoc: Y.Doc) => BrowserDocPersistence;
	clearLocalDataForGuid: (guid: string) => Promise<void>;
}): BrowserDocSource<FileId, BrowserFileContentDocInstance> {
	return {
		ids() {
			return filesTable.getAllValid().map((file) => file.id);
		},
		create(fileId) {
			const doc = createFileContentDoc({
				fileId,
				workspaceId,
				filesTable,
				attachPersistence,
			});
			return {
				...doc,
				persistence: doc.persistence as BrowserDocPersistence | undefined,
				sync: null,
			};
		},
		clearLocalData(fileId) {
			return clearLocalDataForGuid(fileContentDocGuid({ workspaceId, fileId }));
		},
	};
}
