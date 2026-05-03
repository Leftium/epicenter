/**
 * Per-reference content Y.Doc builder. Pure: takes a `referenceId` plus all
 * the deps the construction needs and returns a Disposable bundle. References
 * are tier-3 documentation loaded on demand: each reference file gets its
 * own Y.Doc with `attachPlainText`. Persistence is caller-owned via the
 * `attachPersistence` callback: see `createFileContentDoc` for the shape.
 *
 * Wire into a runtime boundary at the caller. Browser apps use
 * `createBrowserDocumentFamily`; one-shot Node callers open this builder
 * directly and dispose it after the operation.
 */

import type { Table } from '@epicenter/workspace';
import {
	attachPlainText,
	type DocPersistence,
	docGuid,
	onLocalUpdate,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import type { Reference } from './tables.js';

export function referenceContentDocGuid({
	workspaceId,
	referenceId,
}: {
	workspaceId: string;
	referenceId: string;
}): string {
	return docGuid({
		workspaceId,
		collection: 'references',
		rowId: referenceId,
		field: 'content',
	});
}

export function createReferenceContentDoc({
	referenceId,
	workspaceId,
	referencesTable,
	attachPersistence,
}: {
	referenceId: string;
	workspaceId: string;
	referencesTable: Table<Reference>;
	attachPersistence?: (ydoc: Y.Doc) => DocPersistence;
}) {
	const ydoc = new Y.Doc({
		guid: referenceContentDocGuid({ workspaceId, referenceId }),
		gc: false,
	});
	onLocalUpdate(ydoc, () =>
		referencesTable.update(referenceId, { updatedAt: Date.now() }),
	);
	const persistence = attachPersistence?.(ydoc);
	return {
		ydoc,
		content: attachPlainText(ydoc),
		persistence,
		whenReady: persistence?.whenLoaded ?? Promise.resolve(),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
