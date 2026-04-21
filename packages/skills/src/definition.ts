/**
 * @fileoverview Workspace factory for agent skills.
 *
 * Combines `skillsTable` and `referencesTable` under the standard
 * `epicenter.skills` workspace ID. Most consumers should use
 * `createSkillsWorkspace()` from `./workspace.js` — this is exported for
 * advanced use cases like embedding the skills tables in a custom workspace.
 *
 * @module
 */

import { defineWorkspace } from '@epicenter/workspace';
import { referencesTable, skillsTable } from './tables.js';

/**
 * Pre-built workspace factory for the skills workspace.
 *
 * Call `.open('epicenter.skills')` to construct the bundle. Most consumers
 * should use `createSkillsWorkspace()` instead, which also wires the
 * per-skill content-doc factories and read actions.
 */
export const skillsWorkspace = defineWorkspace({
	id: 'epicenter.skills',
	tables: { skills: skillsTable, references: referencesTable },
	kv: {},
});
