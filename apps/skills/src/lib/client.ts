/**
 * Skills app workspace re-exports.
 *
 * `skillsWorkspace` is the shared singleton bundle (ydoc, tables, actions,
 * instructionsDocs, referenceDocs, idb, batch) constructed at module scope
 * inside `@epicenter/skills`. IndexedDB persistence and broadcast-channel
 * fan-out are wired there — consumers don't wire them here.
 *
 * Editors open per-skill handles via `instructionsDocs.open(id)` /
 * `referenceDocs.open(id)` and rely on the shared cache so action-side reads
 * (e.g. `getSkill()`) and component-side edits see the same live Y.Doc.
 */

import { skillsWorkspace } from '@epicenter/skills';

export { skillsWorkspace };
export const instructionsDocs = skillsWorkspace.instructionsDocs;
export const referenceDocs = skillsWorkspace.referenceDocs;
