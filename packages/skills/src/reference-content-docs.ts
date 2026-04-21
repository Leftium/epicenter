/**
 * Reference content documents — per-reference Y.Doc factory.
 *
 * References are additional documentation loaded on demand (tier 3 in the
 * progressive disclosure model). Each reference file gets its own Y.Doc
 * for collaborative editing. The factory is workspace-scoped — apps call
 * `createReferenceContentDocs(ws)` once and reuse the result.
 *
 * NOTE: Sync is deferred to a follow-up. The framework-collapse spec
 * (20260420T230100) lands IDB-only in the first pass.
 */

import {
	attachIndexedDb,
	attachPlainText,
	defineDocument,
	onLocalUpdate,
} from '@epicenter/document';
import type { Table } from '@epicenter/workspace';
import * as Y from 'yjs';
import type { Reference } from './tables.js';

type PersistenceMode = 'indexeddb' | 'none';

export function createReferenceContentDocs(
	referencesTable: Table<Reference>,
	workspaceId = 'skills',
	opts: { persistence?: PersistenceMode } = {},
) {
	const persistence = opts.persistence ?? 'indexeddb';

	function buildReferenceContentDoc(referenceId: string) {
		const ydoc = new Y.Doc({
			guid: `${workspaceId}.references.${referenceId}.content`,
			gc: false,
		});
		const content = attachPlainText(ydoc);
		const idb = persistence === 'indexeddb' ? attachIndexedDb(ydoc) : null;

		onLocalUpdate(ydoc, () => {
			referencesTable.update(referenceId, { updatedAt: Date.now() });
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

	return defineDocument(buildReferenceContentDoc, { gcTime: 30_000 });
}

export type ReferenceContentDocs = ReturnType<
	typeof createReferenceContentDocs
>;
