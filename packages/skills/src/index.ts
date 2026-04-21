/**
 * @fileoverview Browser entry for the shared skills workspace.
 *
 * Exports `skillsDocument` — a `defineDocument` factory that, on `.open(id)`,
 * returns the full skills bundle (tables, KV, encryption, IndexedDB,
 * broadcast channel, actions, per-skill instruction/reference doc factories,
 * batch helper). Consumers call `skillsDocument.open('epicenter.skills')`
 * and use the returned handle directly.
 *
 * For server-side disk I/O (importFromDisk / exportToDisk), use
 * `@epicenter/skills/node` instead.
 *
 * @example
 * ```typescript
 * import { skillsDocument } from '@epicenter/skills';
 *
 * export const workspace = skillsDocument.open('epicenter.skills');
 * export const instructionsDocs = workspace.instructionsDocs;
 * export const referenceDocs = workspace.referenceDocs;
 * ```
 *
 * @module
 */

import {
	attachBroadcastChannel,
	attachIndexedDb,
	defineDocument,
} from '@epicenter/document';
import {
	attachEncryptedKv,
	attachEncryptedTables,
	attachEncryption,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { createReferenceContentDocs } from './reference-content-docs.js';
import { createSkillInstructionsDocs } from './skill-instructions-docs.js';
import { createSkillsActions } from './skills-actions.js';
import { referencesTable, skillsTable } from './tables.js';

export type { Reference, Skill } from './tables.js';
export { referencesTable, skillsTable } from './tables.js';

/**
 * Skills workspace factory. The guid passed to `.open()` is used as the
 * Y.Doc guid — all Epicenter apps should call `.open('epicenter.skills')`
 * so they share the same cached Y.Doc instance within a single process.
 *
 * Note: in a hybrid browser+node process (e.g. Tauri), importing this AND
 * `@epicenter/skills/node` in the same process would give you two separate
 * factories with two separate caches. That isn't a supported configuration
 * today — TODO if we ever need it.
 */
export const skillsDocument = defineDocument(
	(id: string) => {
		const ydoc = new Y.Doc({ guid: id, gc: false });

		const encryption = attachEncryption(ydoc);
		const tables = attachEncryptedTables(ydoc, encryption, {
			skills: skillsTable,
			references: referencesTable,
		});
		const kv = attachEncryptedKv(ydoc, encryption, {});

		const idb = attachIndexedDb(ydoc);
		attachBroadcastChannel(ydoc);

		const instructionsDocs = createSkillInstructionsDocs({
			workspaceId: id,
			skillsTable: tables.skills,
			attach: (ydoc) => attachIndexedDb(ydoc),
		});
		const referenceDocs = createReferenceContentDocs({
			workspaceId: id,
			referencesTable: tables.references,
			attach: (ydoc) => attachIndexedDb(ydoc),
		});

		const actions = createSkillsActions({
			tables,
			instructionsDocs,
			referenceDocs,
		});

		return {
			id,
			ydoc,
			tables,
			kv,
			encryption,
			idb,
			instructionsDocs,
			referenceDocs,
			actions,
			batch: (fn: () => void) => ydoc.transact(fn),
			whenReady: idb.whenLoaded,
			whenDisposed: Promise.all([
				idb.whenDisposed,
				encryption.whenDisposed,
			]).then(() => {}),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	},
	{ gcTime: Number.POSITIVE_INFINITY },
);
