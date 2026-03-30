/**
 * @fileoverview Type exports for the skills package.
 *
 * All types map 1:1 to the [agentskills.io](https://agentskills.io/specification)
 * skill package format. Each frontmatter field in SKILL.md corresponds to a
 * column in the workspace table, and the markdown body maps to a per-row
 * Y.Doc via `.withDocument()`.
 *
 * | agentskills.io field | Table column     | Notes                              |
 * |----------------------|------------------|------------------------------------|
 * | `name`               | `name`           | Slug: lowercase, hyphens, 1-64ch   |
 * | `description`        | `description`    | 1-1024 chars                        |
 * | `license`            | `license?`       | Optional license name or path       |
 * | `compatibility`      | `compatibility?` | Optional env requirements           |
 * | `metadata`           | `metadata?`      | JSON-stringified Record<string,string> |
 * | `allowed-tools`      | `allowedTools?`  | Space-delimited tool names          |
 * | *(body)*             | `.withDocument('instructions')` | Y.Text collaborative content |
 *
 * @module
 */

import type { Skill, Reference } from './tables.js';
export type { Skill, Reference };

/**
 * Script row type—one row per executable file in a skill's `scripts/` directory.
 *
 * Deferred to v2. Defined here for forward-compatible type exports so consumers
 * can reference the shape without importing a table that doesn't exist yet.
 *
 * Maps to the agentskills.io `scripts/` directory: code files (Python, Bash,
 * JavaScript) that agents can run. Self-contained with documented dependencies.
 *
 * @example
 * ```typescript
 * // Future usage when scriptsTable is implemented:
 * const scripts: Script[] = ws.tables.scripts.filter(s => s.skillId === id)
 * ```
 */
export type Script = {
	id: string;
	skillId: string;
	path: string;
	content: string;
	_v: 1;
};

/**
 * Asset row type—one row per static resource in a skill's `assets/` directory.
 *
 * Deferred to v2. Defined here for forward-compatible type exports so consumers
 * can reference the shape without importing a table that doesn't exist yet.
 *
 * Maps to the agentskills.io `assets/` directory: templates (JSON, YAML),
 * images (PNG, SVG), and data files (CSV, schemas). Text-only for now—binary
 * files are skipped on import.
 *
 * @example
 * ```typescript
 * // Future usage when assetsTable is implemented:
 * const assets: Asset[] = ws.tables.assets.filter(a => a.skillId === id)
 * ```
 */
export type Asset = {
	id: string;
	skillId: string;
	path: string;
	content: string;
	_v: 1;
};

/**
 * Minimal workspace client shape required by `importFromDisk` and `exportToDisk`.
 *
 * Structurally compatible with the result of `createWorkspace(defineWorkspace({
 *   id: 'epicenter.skills',
 *   tables: { skills: skillsTable, references: referencesTable },
 * }))`. Duck-typed so import/export don't depend on the full generic workspace
 * client type.
 *
 * @example
 * ```typescript
 * import { skillsTable, referencesTable } from '@epicenter/skills'
 * import { defineWorkspace, createWorkspace } from '@epicenter/workspace'
 *
 * const ws = createWorkspace(defineWorkspace({
 *   id: 'epicenter.skills',
 *   tables: { skills: skillsTable, references: referencesTable },
 *   kv: {},
 * }))
 *
 * // ws satisfies SkillsWorkspaceClient
 * await importFromDisk('.agents/skills', ws)
 * ```
 */
export type SkillsWorkspaceClient = {
	tables: {
		skills: SkillsTableHelper;
		references: ReferencesTableHelper;
	};
	documents: {
		skills: {
			instructions: DocumentManager;
		};
		references: {
			content: DocumentManager;
		};
	};
};

/** Minimal table helper shape for the skills table. */
type SkillsTableHelper = {
	set(row: Skill): void;
	getAllValid(): Skill[];
	find(predicate: (row: Skill) => boolean): Skill | undefined;
	filter(predicate: (row: Skill) => boolean): Skill[];
	delete(id: string): void;
};

/** Minimal table helper shape for the references table. */
type ReferencesTableHelper = {
	set(row: Reference): void;
	getAllValid(): Reference[];
	filter(predicate: (row: Reference) => boolean): Reference[];
	delete(id: string): void;
};

/** Minimal document manager shape—open returns a handle with read/write. */
type DocumentManager = {
	open(input: string): Promise<DocumentHandleMinimal>;
};

/** Minimal document handle—read string content, write string content. */
type DocumentHandleMinimal = {
	read(): string;
	write(text: string): void;
};
