/**
 * Skills app workspace re-exports.
 *
 * `skillsWorkspace` is the bare workspace bundle (ydoc, tables, kv,
 * encryption, idb, batch). The per-row caches (`instructionsDocs`,
 * `referenceDocs`) and the action layer (`skillsActions`) are sibling
 * exports from `@epicenter/skills` — re-export them here for app-local
 * convenience.
 *
 * Editors open per-skill handles via `instructionsDocs.open(id)` /
 * `referenceDocs.open(id)` and rely on the shared cache so action-side reads
 * (e.g. `getSkill()`) and component-side edits see the same live Y.Doc.
 */

export {
	instructionsDocs,
	referenceDocs,
	skillsActions,
	skillsWorkspace,
} from '@epicenter/skills';
