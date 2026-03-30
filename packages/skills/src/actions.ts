/**
 * @fileoverview Pre-built actions factory for the skills workspace.
 *
 * Wraps `importFromDisk` and `exportToDisk` as `defineMutation` actions
 * so they can be attached to a workspace client via `.withActions(skillsActions)`.
 *
 * The factory only needs `tables` and `documents`—no extensions required.
 * This makes it safe to call `.withActions(skillsActions)` before any
 * `.withExtension()` calls in the builder chain.
 *
 * @module
 */

import { defineMutation } from '@epicenter/workspace';
import type { Static } from 'typebox';
import { Type } from 'typebox';
import { exportToDisk, importFromDisk } from './disk.js';
import type { SkillsWorkspaceClient } from './disk.js';

const DirInput = Type.Object({ dir: Type.String() });

/**
 * Actions factory for the skills workspace.
 *
 * Pass to `.withActions()` on a workspace created from `skillsDefinition`.
 * The factory closes over the client's tables and documents to provide
 * disk I/O operations as workspace actions.
 *
 * @example
 * ```typescript
 * import { skillsDefinition, skillsActions } from '@epicenter/skills';
 * import { createWorkspace } from '@epicenter/workspace';
 *
 * const ws = createWorkspace(skillsDefinition)
 *   .withActions(skillsActions)
 *   .withExtension('persistence', indexeddbPersistence);
 *
 * await ws.actions.importFromDisk({ dir: '.agents/skills' });
 * await ws.actions.exportToDisk({ dir: '.agents/skills' });
 * ```
 */
export function skillsActions(client: SkillsWorkspaceClient) {
	return {
		importFromDisk: defineMutation({
			description: 'Import skills from an agentskills.io-compliant directory',
			input: DirInput,
			handler: ({ dir }: Static<typeof DirInput>) =>
				importFromDisk(dir, client),
		}),
		exportToDisk: defineMutation({
			description:
				'Export all skills to an agentskills.io-compliant directory',
			input: DirInput,
			handler: ({ dir }: Static<typeof DirInput>) =>
				exportToDisk(client, dir),
		}),
	};
}
