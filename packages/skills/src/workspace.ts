/**
 * @fileoverview Pre-built workspace definition for agent skills.
 *
 * Exports a `defineWorkspace()` result that consumers can pass directly
 * to `createWorkspace()`. For embedding skills tables in a larger workspace,
 * import `skillsTable` and `referencesTable` directly instead.
 *
 * @module
 */

import { defineWorkspace } from '@epicenter/workspace';
import { referencesTable, skillsTable } from './tables.js';

/**
 * Pre-built workspace definition for the skills workspace.
 *
 * Combines `skillsTable` and `referencesTable` under the standard
 * `epicenter.skills` workspace ID. Pass to `createWorkspace()` and
 * chain `.withActions(skillsActions)` for the full package.
 *
 * @example
 * ```typescript
 * import { skillsDefinition, skillsActions } from '@epicenter/skills';
 * import { createWorkspace } from '@epicenter/workspace';
 *
 * const ws = createWorkspace(skillsDefinition)
 *   .withActions(skillsActions)
 *   .withExtension('persistence', indexeddbPersistence);
 * ```
 */
export const skillsDefinition = defineWorkspace({
	id: 'epicenter.skills',
	tables: { skills: skillsTable, references: referencesTable },
	kv: {},
});
