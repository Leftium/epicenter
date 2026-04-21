/**
 * Skills app workspace client — browser entry with IndexedDB persistence.
 *
 * `createSkillsWorkspace()` returns the shared skills workspace bundle
 * (ydoc, tables, actions, instructionsDocs, referenceDocs). This file
 * attaches IDB persistence on top and re-exports the doc factories for
 * editor components.
 *
 * Editors open per-skill handles via `instructionsDocs.open(id)` /
 * `referenceDocs.open(id)` and rely on the shared cache so action-side
 * reads (e.g. `getSkill()`) and component-side edits see the same live
 * Y.Doc.
 */

import { attachIndexedDb } from '@epicenter/document';
import { createSkillsWorkspace } from '@epicenter/skills';

const base = createSkillsWorkspace();
const idb = attachIndexedDb(base.ydoc);

export const workspace = Object.assign(base, {
	idb,
	whenReady: idb.whenLoaded,
});
export const instructionsDocs = base.instructionsDocs;
export const referenceDocs = base.referenceDocs;
