/**
 * Browser entry for the shared skills workspace.
 *
 * `openSkills()` returns the bare workspace bundle (ydoc + tables + kv +
 * encryption + idb). The per-row content caches (`instructionsDocs`,
 * `referenceDocs`) and the action layer (`skillsActions`) are sibling
 * exports at module scope — they conceptually manage *other* Y.Docs (one
 * per skill / reference) and shouldn't be nested under the workspace bundle.
 *
 * Per-id caches (`instructionsDocs`, `referenceDocs`) wrap pure builders in
 * `createDisposableCache` — the refcounted cache earns its keep because the
 * same skill/reference id can be opened from multiple components.
 *
 * For server-side disk I/O (importFromDisk / exportToDisk), use
 * `@epicenter/skills/node` instead.
 *
 * @example
 * ```typescript
 * import { instructionsDocs } from '@epicenter/skills';
 * const handle = instructionsDocs.open(skillId);
 * ```
 *
 * @module
 */

import {
	attachBroadcastChannel,
	attachEncryption,
	attachIndexedDb,
	createDisposableCache,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { createReferenceContentDoc } from './reference-content-docs.js';
import { createSkillInstructionsDoc } from './skill-instructions-docs.js';
import { createSkillsActions } from './skills-actions.js';
import { referencesTable, skillsTable } from './tables.js';

export type { Reference, Skill } from './tables.js';
export { referencesTable, skillsTable } from './tables.js';

function openSkills() {
	const ydoc = new Y.Doc({ guid: 'epicenter.skills', gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, {
		skills: skillsTable,
		references: referencesTable,
	});
	const kv = encryption.attachKv(ydoc, {});

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);

	return {
		ydoc,
		tables,
		kv,
		encryption,
		idb,
		batch: (fn: () => void) => ydoc.transact(fn),
		whenReady: idb.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

/** Singleton skills workspace. Construct once at module scope. */
export const skillsWorkspace = openSkills();

export const instructionsDocs = createDisposableCache(
	(skillId: string) =>
		createSkillInstructionsDoc({
			skillId,
			workspaceId: skillsWorkspace.ydoc.guid,
			skillsTable: skillsWorkspace.tables.skills,
			attachPersistence: (doc) => attachIndexedDb(doc),
		}),
	{ gcTime: 5_000 },
);

export const referenceDocs = createDisposableCache(
	(referenceId: string) =>
		createReferenceContentDoc({
			referenceId,
			workspaceId: skillsWorkspace.ydoc.guid,
			referencesTable: skillsWorkspace.tables.references,
			attachPersistence: (doc) => attachIndexedDb(doc),
		}),
	{ gcTime: 5_000 },
);

export const skillsActions = createSkillsActions({
	tables: skillsWorkspace.tables,
	instructionsDocs,
	referenceDocs,
});
