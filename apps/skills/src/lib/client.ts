/**
 * Skills app workspace client — browser entry with IndexedDB persistence.
 *
 * `createSkillsWorkspace()` returns `{ workspace, instructionsDocs, referenceDocs }`
 * pre-wired to share a handle cache. This file layers IDB persistence on the
 * workspace builder and re-exports the doc factories for editor components.
 *
 * Editors open per-skill handles via `instructionsDocs.open(id)` / `referenceDocs.open(id)`
 * and rely on the shared cache so action-side reads (e.g. `getSkill()`) and
 * component-side edits see the same live Y.Doc.
 */

import { createSkillsWorkspace } from '@epicenter/skills';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';

const skills = createSkillsWorkspace();

export const workspace = skills.workspace.withExtension(
	'persistence',
	indexeddbPersistence,
);
export const instructionsDocs = skills.instructionsDocs;
export const referenceDocs = skills.referenceDocs;
