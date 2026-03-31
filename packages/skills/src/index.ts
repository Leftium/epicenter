/**
 * @fileoverview Isomorphic workspace tables and factory for agent skills.
 *
 * This entry point is safe to import in any runtime (browser, Node, Bun).
 * For server-side disk I/O actions, use `@epicenter/skills/disk` instead.
 *
 * @example Browser — tables only
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills'
 *
 * const ws = createSkillsWorkspace()
 *   .withExtension('persistence', indexeddbPersistence)
 * ```
 *
 * @example Server — with disk I/O
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills/disk'
 *
 * const ws = createSkillsWorkspace()
 * await ws.actions.importFromDisk({ dir: '.agents/skills' })
 * ```
 *
 * @module
 */

// Workspace factory + definition
export { createSkillsWorkspace, skillsDefinition } from './workspace.js';

// Tables + types (for embedding in custom workspaces)
export { skillsTable, referencesTable } from './tables.js';
export type { Skill, Reference } from './tables.js';
