/**
 * @fileoverview Isomorphic workspace tables and factory for agent skills.
 *
 * This entry point is safe to import in any runtime (browser, Node, Bun).
 * For server-side disk I/O actions, use `@epicenter/skills/node` instead.
 *
 * @example Browser
 * ```typescript
 * import { attachIndexedDb } from '@epicenter/document';
 * import { createSkillsWorkspace } from '@epicenter/skills';
 *
 * const base = createSkillsWorkspace();
 * const idb = attachIndexedDb(base.ydoc);
 * export const workspace = Object.assign(base, {
 *   idb,
 *   whenReady: idb.whenLoaded,
 * });
 * ```
 *
 * @example Server — with disk I/O
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills/node';
 *
 * const ws = createSkillsWorkspace();
 * await ws.actions.importFromDisk({ dir: '.agents/skills' });
 * ```
 *
 * @module
 */

export { skillsWorkspace } from './definition.js';
export type { Reference, Skill } from './tables.js';
export { referencesTable, skillsTable } from './tables.js';
export { createSkillsWorkspace } from './workspace.js';
