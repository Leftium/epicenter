/**
 * @fileoverview Workspace tables and factory for agent skills.
 *
 * Provides a 1:1 mapping of the [agentskills.io](https://agentskills.io/specification)
 * skill package format to Yjs CRDT-backed workspace tables.
 *
 * @example
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills'
 *
 * const ws = createSkillsWorkspace()
 *   .withExtension('persistence', indexeddbPersistence)
 *
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
