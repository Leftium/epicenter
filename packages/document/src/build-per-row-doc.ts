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
 *     const base = buildPerRowDoc({
 *       workspaceId, collection: 'files', field: 'content', id: fileId,
 *       onUpdate: () => filesTable.update(fileId, { updatedAt: Date.now() }),
 *       attach,
 *     });
 *     return { ...base, content: attachTimeline(base.ydoc) };
 *   });
 */

import * as Y from 'yjs';
import { docGuid } from './doc-guid.js';
import { NO_PERSISTENCE, type DocPersistence } from './doc-persistence.js';
import { onLocalUpdate } from './on-local-update.js';

export type PerRowDocBase = {
	ydoc: Y.Doc;
	whenReady: Promise<void>;
	whenDisposed: Promise<void>;
	[Symbol.dispose](): void;
};

export function buildPerRowDoc<Id extends string>({
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
