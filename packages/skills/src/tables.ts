/**
 * @fileoverview Workspace table definitions for agent skills.
 *
 * Maps the [agentskills.io](https://agentskills.io/specification) skill
 * package format to Yjs CRDT-backed tables. Each frontmatter field becomes
 * a column; the markdown instruction body lives in a per-row Y.Doc via
 * `.withDocument('instructions')`.
 *
 * @module
 */

import { defineTable, type InferTableRow } from '@epicenter/workspace';
import { type } from 'arktype';

/**
 * Skills table—one row per skill, 1:1 mapping to SKILL.md.
 *
 * Frontmatter fields map to columns. The markdown instructions live in
 * an attached Y.Doc via `.withDocument('instructions')`, enabling
 * collaborative Y.Text editing in browser-based editors.
 *
 * The `id` is a stable nanoid for FK relationships. The `name` column
 * holds the agentskills.io-compliant slug (lowercase, hyphens, 1-64 chars)
 * and can be renamed without cascading updates to child rows.
 *
 * @example
 * ```typescript
 * // Catalog (tier 1)—which skills exist?
 * const catalog = ws.tables.skills.getAllValid()
 *   .map(s => ({ name: s.name, description: s.description }))
 *
 * // Activate (tier 2)—inject instructions into context
 * const skill = ws.tables.skills.find(s => s.name === 'writing-voice')
 * if (skill) {
 *   const handle = await ws.documents.skills.instructions.open(skill.id)
 *   systemPrompt += handle.read()
 * }
 *
 * // Editor binding—collaborative Y.Text editing
 * const handle = await ws.documents.skills.instructions.open(skill.id)
 * const ytext = handle.asText()
 * editor.bind(ytext)
 * ```
 */
export const skillsTable = defineTable(
	type({
		id: 'string',
		name: 'string',
		description: 'string',
		'license?': 'string | undefined',
		'compatibility?': 'string | undefined',
		'metadata?': 'string | undefined',
		'allowedTools?': 'string | undefined',
		updatedAt: 'number',
		_v: '1',
	}),
).withDocument('instructions', {
	guid: 'id',
	onUpdate: () => ({ updatedAt: Date.now() }),
});

/**
 * References table—one row per markdown file in a skill's `references/` directory.
 *
 * References are additional documentation loaded on demand (tier 3 in the
 * progressive disclosure model). Each reference file gets its own Y.Doc
 * via `.withDocument('content')` for collaborative editing.
 *
 * The `path` column stores the filename relative to the `references/` directory
 * (e.g., `"component-patterns.md"`), not the full filesystem path.
 *
 * @example
 * ```typescript
 * // Load all references for a skill
 * const refs = ws.tables.references.filter(r => r.skillId === skill.id)
 *
 * // Read reference content
 * for (const ref of refs) {
 *   const handle = await ws.documents.references.content.open(ref.id)
 *   const markdown = handle.read()
 * }
 * ```
 */
export const referencesTable = defineTable(
	type({
		id: 'string',
		skillId: 'string',
		path: 'string',
		updatedAt: 'number',
		_v: '1',
	}),
).withDocument('content', {
	guid: 'id',
	onUpdate: () => ({ updatedAt: Date.now() }),
});

// ════════════════════════════════════════════════════════════════════════════
// DEFERRED TABLES (v2)
//
// The following tables are spec'd for completeness per the agentskills.io
// specification but not implemented in v1. Only `references/` is used across
// the existing 49 skills. Uncomment and implement when needed.
// ════════════════════════════════════════════════════════════════════════════

// /**
//  * Scripts table—one row per executable file in a skill's `scripts/` directory.
//  *
//  * Scripts are code files (Python, Bash, JavaScript) that agents can run.
//  * Stored as a plain `content` column—no `.withDocument()` needed for v1.
//  * Add collaborative code editing later if the skills editor supports it.
//  *
//  * Deferred: no existing skills use `scripts/`.
//  *
//  * @example
//  * ```typescript
//  * const scripts = ws.tables.scripts.filter(s => s.skillId === skill.id)
//  * for (const script of scripts) {
//  *   await runScript(script.path, script.content)
//  * }
//  * ```
//  */
// export const scriptsTable = defineTable(
// 	type({
// 		id: 'string',
// 		skillId: 'string',
// 		path: 'string',
// 		content: 'string',
// 		_v: '1',
// 	}),
// );

// /**
//  * Assets table—one row per static resource in a skill's `assets/` directory.
//  *
//  * Assets include templates (JSON, YAML), images (PNG, SVG), and data files
//  * (CSV, schemas). Text-only for now—binary files (images) are skipped on
//  * import. Add base64 encoding or a binary column type when needed.
//  *
//  * No `.withDocument()`—assets are static resources, not collaboratively edited.
//  *
//  * Deferred: no existing skills use `assets/`.
//  *
//  * @example
//  * ```typescript
//  * const assets = ws.tables.assets.filter(a => a.skillId === skill.id)
//  * const template = assets.find(a => a.path === 'template.json')
//  * if (template) {
//  *   const data = JSON.parse(template.content)
//  * }
//  * ```
//  */
// export const assetsTable = defineTable(
// 	type({
// 		id: 'string',
// 		skillId: 'string',
// 		path: 'string',
// 		content: 'string',
// 		_v: '1',
// 	}),
// );

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

export type Skill = InferTableRow<typeof skillsTable>;
export type Reference = InferTableRow<typeof referencesTable>;
