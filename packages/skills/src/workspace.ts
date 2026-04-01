/**
 * @fileoverview Isomorphic workspace definition and factory for agent skills.
 *
 * `createSkillsWorkspace()` returns a workspace client with tables only—no
 * actions attached. This is safe to import in any runtime (browser, Node, Bun).
 *
 * For disk I/O actions (importFromDisk, exportToDisk), import from
 * `@epicenter/skills/node` instead—that subpath re-exports a pre-built
 * `createSkillsWorkspace()` with server-side actions attached.
 *
 * @module
 */

import { createWorkspace, defineWorkspace } from '@epicenter/workspace';
import { referencesTable, skillsTable } from './tables.js';

/**
 * Pre-built workspace definition for the skills workspace.
 *
 * Combines `skillsTable` and `referencesTable` under the standard
 * `epicenter.skills` workspace ID. Most consumers should use
 * `createSkillsWorkspace()` instead—this is exported for advanced use cases
 * like embedding skills tables in a custom workspace.
 */
export const skillsDefinition = defineWorkspace({
	id: 'epicenter.skills',
	tables: { skills: skillsTable, references: referencesTable },
	kv: {},
});

/**
 * Create an isomorphic skills workspace client (tables only, no actions).
 *
 * Returns a non-terminal builder—chain `.withExtension()` to add persistence,
 * sync, or other capabilities. Chain `.withActions()` to attach custom actions.
 *
 * For a pre-built workspace with disk I/O actions, import from
 * `@epicenter/skills/disk` instead.
 *
 * @example Browser — tables only
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills'
 *
 * const ws = createSkillsWorkspace()
 *   .withExtension('persistence', indexeddbPersistence)
 * ```
 *
 * @example Server — with disk I/O (use the /node subpath)
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills/node'
 *
 * const ws = createSkillsWorkspace()
 *   .withExtension('persistence', indexeddbPersistence)
 *
 * await ws.actions.importFromDisk({ dir: '.agents/skills' })
 * ```
 */
export function createSkillsWorkspace() {
	return createWorkspace(skillsDefinition);
}
