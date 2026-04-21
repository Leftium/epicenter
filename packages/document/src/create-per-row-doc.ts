/**
 * Shared plumbing for per-row content-doc factories
 * (`createFileContentDocs`, `createSkillInstructionsDocs`,
 * `createReferenceContentDocs`, and anything else that follows the same
 * shape).
 *
 * Builds the base bundle — Y.Doc with a workspace-scoped guid, `onLocalUpdate`
 * writeback hook, persistence threading, and sync dispose. Domain-specific
 * content attachment (`attachTimeline`, `attachPlainText`, etc.) is composed
 * by the caller:
 *
 *   return defineDocument((fileId: FileId) => {
 *     const base = createPerRowDoc({
 *       workspaceId, collection: 'files', field: 'content', id: fileId,
 *       onUpdate: () => filesTable.update(fileId, { updatedAt: Date.now() }),
 *       attach,
 *     });
 *     return { ...base, content: attachTimeline(base.ydoc) };
 *   });
 *
 * Persistence is caller-owned via the `attach` callback. Any function
 * returning `{ whenLoaded, whenDisposed }` works — `attachIndexedDb` and
 * `attachSqlite` both structurally satisfy `DocPersistence`:
 *
 *   attach: (ydoc) => attachIndexedDb(ydoc)                         // browser
 *   attach: (ydoc) => attachSqlite(ydoc, { filePath })              // desktop
 *   // omit for in-memory (tests, Node stubs) — falls back to NO_PERSISTENCE
 */

import * as Y from 'yjs';
import { docGuid } from './doc-guid.js';
import { onLocalUpdate } from './on-local-update.js';

/**
 * Consumer contract for `attach` callbacks. Both fields are required — every
 * real persistence attachment signals initial-load readiness and final
 * teardown, and requiring them here catches missing providers at the
 * callback's definition site instead of at runtime. Attachments without async
 * teardown can set `whenDisposed: Promise.resolve()`.
 *
 * This is a *consumer contract*, not a produced attachment — there is no
 * `attachPersistence()` function. Real producers (`attachIndexedDb`,
 * `attachSqlite`) return richer types that structurally satisfy this shape.
 */
export type DocPersistence = {
	whenLoaded: Promise<void>;
	whenDisposed: Promise<void>;
};

/** No-op fallback when no `attach` callback is provided (pure in-memory). */
const NO_PERSISTENCE: DocPersistence = {
	whenLoaded: Promise.resolve(),
	whenDisposed: Promise.resolve(),
};

type PerRowDocBase = {
	ydoc: Y.Doc;
	whenReady: Promise<void>;
	whenDisposed: Promise<void>;
	[Symbol.dispose](): void;
};

export function createPerRowDoc<Id extends string>({
	workspaceId,
	collection,
	field,
	id,
	onUpdate,
	attach,
}: {
	workspaceId: string;
	collection: string;
	field: string;
	id: Id;
	onUpdate: () => void;
	attach?: (ydoc: Y.Doc) => DocPersistence;
}): PerRowDocBase {
	const ydoc = new Y.Doc({
		guid: docGuid({ workspaceId, collection, rowId: id, field }),
		gc: false,
	});
	onLocalUpdate(ydoc, onUpdate);
	const persistence = attach?.(ydoc) ?? NO_PERSISTENCE;
	return {
		ydoc,
		whenReady: persistence.whenLoaded,
		whenDisposed: persistence.whenDisposed,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
