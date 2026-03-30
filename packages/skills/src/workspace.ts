/**
 * @fileoverview Workspace definition and factory for agent skills.
 *
 * The primary export is `createSkillsWorkspace()`—a factory that returns a
 * workspace client with disk I/O actions already attached. The returned
 * builder is non-terminal: consumers can chain `.withExtension()` or
 * additional `.withActions()` calls.
 *
 * For embedding skills tables in a larger workspace, import `skillsTable`
 * and `referencesTable` directly instead.
 *
 * @module
 */

import {
	createWorkspace,
	defineMutation,
	defineWorkspace,
} from '@epicenter/workspace';
import type { Static } from 'typebox';
import { Type } from 'typebox';
import { exportToDisk, importFromDisk } from './disk.js';
import { referencesTable, skillsTable } from './tables.js';

const DirInput = Type.Object({ dir: Type.String() });

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
 * Create a skills workspace client with disk I/O actions pre-attached.
 *
 * Returns a non-terminal builder—chain `.withExtension()` to add persistence,
 * sync, or other capabilities. Actions are available immediately on the returned
 * client via `ws.actions.importFromDisk()` and `ws.actions.exportToDisk()`.
 *
 * @example
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills'
 *
 * const ws = createSkillsWorkspace()
 *   .withExtension('persistence', indexeddbPersistence)
 *
 * await ws.actions.importFromDisk({ dir: '.agents/skills' })
 * await ws.actions.exportToDisk({ dir: '.agents/skills' })
 * ```
 *
 * @example Chaining additional actions
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills'
 * import { defineMutation } from '@epicenter/workspace'
 *
 * const ws = createSkillsWorkspace()
 *   .withActions(({ tables }) => ({
 *     clearAll: defineMutation({
 *       description: 'Delete all skills',
 *       handler: () => tables.skills.clear(),
 *     }),
 *   }))
 *   .withExtension('persistence', indexeddbPersistence)
 * ```
 */
export function createSkillsWorkspace() {
	return createWorkspace(skillsDefinition).withActions((client) => ({
		/**
		 * Scan a directory of SKILL.md files and upsert them into the workspace.
		 *
		 * Skills without a `metadata.id` in their frontmatter get one generated
		 * and written back to the file, so future imports produce stable IDs
		 * across machines. References in `references/*.md` subdirectories are
		 * imported with deterministic IDs derived from skillId + filename.
		 */
		importFromDisk: defineMutation({
			description: 'Import skills from an agentskills.io-compliant directory',
			input: DirInput,
			handler: ({ dir }: Static<typeof DirInput>) =>
				importFromDisk(dir, client),
		}),
		/**
		 * Serialize workspace table data to agentskills.io-compliant folders.
		 *
		 * One-way publish step—run this when you want agent runtimes (Codex,
		 * Claude Code, OpenCode) to pick up the latest skill definitions.
		 * Stale directories for deleted skills are cleaned up automatically.
		 */
		exportToDisk: defineMutation({
			description:
				'Export all skills to an agentskills.io-compliant directory',
			input: DirInput,
			handler: ({ dir }: Static<typeof DirInput>) =>
				exportToDisk(client, dir),
		}),
	}));
}
