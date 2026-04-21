/**
 * Skills app workspace client — browser entry with IndexedDB persistence.
 *
 * `skillsDocument.open('epicenter.skills')` returns the full skills bundle
 * (ydoc, tables, actions, instructionsDocs, referenceDocs, idb, batch).
 * IndexedDB persistence and broadcast-channel fan-out are attached by the
 * factory itself — consumers don't wire them here.
 *
 * Editors open per-skill handles via `instructionsDocs.open(id)` /
 * `referenceDocs.open(id)` and rely on the shared cache so action-side
 * reads (e.g. `getSkill()`) and component-side edits see the same live
 * Y.Doc.
 */

import { skillsDocument } from '@epicenter/skills';

export const workspace = skillsDocument.open('epicenter.skills');
export const instructionsDocs = workspace.instructionsDocs;
export const referenceDocs = workspace.referenceDocs;
