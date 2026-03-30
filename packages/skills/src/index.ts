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

// Tables + types
export { skillsTable, referencesTable } from './tables.js';
export type { Skill, Reference, Script, Asset } from './tables.js';

// Parse
export { parseSkillMd, parseReferenceMd, splitFrontmatter } from './parse.js';

// Serialize
export { serializeSkillMd, serializeReferenceMd } from './serialize.js';

// Disk I/O
export { importFromDisk, exportToDisk } from './disk.js';
export type { SkillsWorkspaceClient } from './disk.js';
