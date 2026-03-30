/**
 * @fileoverview Workspace table definitions and utilities for agent skills.
 *
 * Provides a 1:1 mapping of the [agentskills.io](https://agentskills.io/specification)
 * skill package format to Yjs CRDT-backed workspace tables. Skills are a shared
 * runtime resource—consumed by browser apps, edge workers, and desktop apps.
 * Export to the agentskills.io folder format is a secondary publish step for
 * Codex/Claude Code/OpenCode compatibility.
 *
 * @example
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

// Tables
export { skillsTable, referencesTable } from './tables.js';

// Types
export type {
	Skill,
	Reference,
	Script,
	Asset,
	SkillsWorkspaceClient,
} from './types.js';

// Parse
export { parseSkillMd, parseReferenceMd } from './parse.js';

// Serialize
export { serializeSkillMd, serializeReferenceMd } from './serialize.js';

// Import / Export
export { importFromDisk } from './import.js';
export { exportToDisk } from './export.js';
