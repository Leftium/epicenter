/**
 * Browser entry for the shared skills workspace.
 *
 * Exports `skillsWorkspace` — the singleton skills bundle (tables, KV,
 * encryption, IndexedDB, broadcast channel, actions, per-skill instruction
 * and reference doc caches, batch helper) opened at `'epicenter.skills'`.
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
 * import { skillsWorkspace } from '@epicenter/skills';
 * const handle = skillsWorkspace.instructionsDocs.open(skillId);
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

// ─── ydoc + state ──────────────────────────────────────────────────────
const ydoc = new Y.Doc({ guid: 'epicenter.skills', gc: false });
const encryption = attachEncryption(ydoc);
const tables = encryption.attachTables(ydoc, {
	skills: skillsTable,
	references: referencesTable,
});
const kv = encryption.attachKv(ydoc, {});

// ─── storage ───────────────────────────────────────────────────────────
const idb = attachIndexedDb(ydoc);
attachBroadcastChannel(ydoc);

// ─── per-row content caches ────────────────────────────────────────────
const instructionsDocs = createDisposableCache(
	(skillId: string) =>
		createSkillInstructionsDoc({
			skillId,
			workspaceId: 'epicenter.skills',
			skillsTable: tables.skills,
			attachPersistence: (doc) => attachIndexedDb(doc),
		}),
	{ gcTime: 5_000 },
);

const referenceDocs = createDisposableCache(
	(referenceId: string) =>
		createReferenceContentDoc({
			referenceId,
			workspaceId: 'epicenter.skills',
			referencesTable: tables.references,
			attachPersistence: (doc) => attachIndexedDb(doc),
		}),
	{ gcTime: 5_000 },
);

// ─── actions ───────────────────────────────────────────────────────────
const actions = createSkillsActions({
	tables,
	instructionsDocs,
	referenceDocs,
});

// ─── export ────────────────────────────────────────────────────────────
/** Singleton skills workspace. Construct once at module scope. */
export const skillsWorkspace = {
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
