/**
 * @fileoverview Workspace table definitions and utilities for agent skills.
 *
 * Provides a 1:1 mapping of the [agentskills.io](https://agentskills.io/specification)
 * skill package format to Yjs CRDT-backed workspace tables. Skills are a shared
 * runtime resource—consumed by browser apps, edge workers, and desktop apps.
 * Export to the agentskills.io folder format is a secondary publish step for
 * Codex/Claude Code/OpenCode compatibility.
 *
 * @example Using the pre-built definition + actions (recommended)
 * ```typescript
 * import { skillsDefinition, skillsActions } from '@epicenter/skills'
 * import { createWorkspace } from '@epicenter/workspace'
 *
 * const ws = createWorkspace(skillsDefinition)
 *   .withActions(skillsActions)
 *   .withExtension('persistence', indexeddbPersistence)
 *
 * await ws.actions.importFromDisk({ dir: '.agents/skills' })
 * ```
 *
 * @example Using raw tables in a custom workspace
 * ```typescript
 * import { skillsTable, referencesTable, importFromDisk } from '@epicenter/skills'
 * import { defineWorkspace, createWorkspace } from '@epicenter/workspace'
 *
 * const ws = createWorkspace(defineWorkspace({
 *   id: 'epicenter.skills',
 *   tables: { skills: skillsTable, references: referencesTable },
 *   kv: {},
 * }))
 *
 * await importFromDisk('.agents/skills', ws)
 * ```
 *
 * @module
 */

// Tables + types
export { skillsTable, referencesTable } from './tables.js';
export type { Skill, Reference } from './tables.js';

// Parse
export { parseSkillMd, parseReferenceMd } from './parse.js';

// Serialize
export { serializeSkillMd } from './serialize.js';

// Disk I/O
export { importFromDisk, exportToDisk } from './disk.js';
export type { SkillsWorkspaceClient } from './disk.js';

// Pre-built workspace definition + actions factory
export { skillsDefinition } from './workspace.js';
export { skillsActions } from './actions.js';
