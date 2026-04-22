/**
 * @fileoverview Browser entry for the shared skills workspace.
 *
 * Exports `openSkills()` — a direct builder that returns the full skills
 * bundle (tables, KV, encryption, IndexedDB, broadcast channel, actions,
 * per-skill instruction/reference doc factories, batch helper) — and
 * `skillsWorkspace`, the singleton instance opened at `'epicenter.skills'`.
 *
 * Nested per-id factories (`instructionsDocs`, `referenceDocs`) still live
 * on `createDocumentFactory` — the ref-counted cache earns its keep there because
 * the same skill/reference id can be opened from multiple components.
 *
 * For server-side disk I/O (importFromDisk / exportToDisk), use
 * `@epicenter/skills/node` instead.
 *
 * @example
 * ```typescript
 * import { skillsWorkspace } from '@epicenter/skills';
 *
 * export const workspace = skillsWorkspace;
 * export const instructionsDocs = workspace.instructionsDocs;
 * export const referenceDocs = workspace.referenceDocs;
 * ```
 *
 * @module
 */

import {
	attachBroadcastChannel,
	attachIndexedDb,
} from '@epicenter/workspace';
import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { createReferenceContentDocs } from './reference-content-docs.js';
import { createSkillInstructionsDocs } from './skill-instructions-docs.js';
import { createSkillsActions } from './skills-actions.js';
import { referencesTable, skillsTable } from './tables.js';

export type { Reference, Skill } from './tables.js';
export { referencesTable, skillsTable } from './tables.js';

/**
 * Build a skills workspace bundle. All Epicenter apps in the same process
 * should share the singleton `skillsWorkspace` export below rather than
 * calling `openSkills` again.
 *
 * Note: in a hybrid browser+node process (e.g. Tauri), importing this AND
 * `@epicenter/skills/node` in the same process would give you two separate
 * bundles. That isn't a supported configuration today — TODO if we ever
 * need it.
 */
export function openSkills() {
	const id = 'epicenter.skills';
	const ydoc = new Y.Doc({ guid: id, gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, {
		skills: skillsTable,
		references: referencesTable,
	});
	const kv = encryption.attachKv(ydoc, {});

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);

	const instructionsDocs = createSkillInstructionsDocs({
		workspaceId: id,
		skillsTable: tables.skills,
		attachPersistence: (ydoc) => attachIndexedDb(ydoc),
	});
	const referenceDocs = createReferenceContentDocs({
		workspaceId: id,
		referencesTable: tables.references,
		attachPersistence: (ydoc) => attachIndexedDb(ydoc),
	});

	const actions = createSkillsActions({
		tables,
		instructionsDocs,
		referenceDocs,
	});

	return {
		get id() {
			return ydoc.guid;
		},
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
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

/** Singleton skills workspace. Construct once at module scope. */
export const skillsWorkspace = openSkills();
