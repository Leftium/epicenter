/**
 * @fileoverview Export skills from workspace tables to agentskills.io-compliant folders.
 *
 * Reads all skills from the workspace, serializes them back to SKILL.md format,
 * and writes the files to disk. Also exports reference files and cleans up
 * folders for skills that no longer exist in the workspace.
 *
 * @module
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serializeReferenceMd, serializeSkillMd } from './serialize.js';
import type { SkillsWorkspaceClient } from './types.js';

/**
 * Export all skills from workspace tables to agentskills.io-compliant folders.
 *
 * For each skill in the workspace:
 *
 * 1. Creates a directory named after the skill's `name` column
 * 2. Serializes the skill row + instructions document into a SKILL.md file
 * 3. Writes each reference document to `references/{path}`
 * 4. Removes directories for skills that no longer exist in the workspace
 *
 * This is a one-way publish step, not bidirectional sync. Run it when you want
 * to update the `.agents/skills/` folders for agent runtime consumption.
 *
 * @param workspace - A workspace client with skills/references tables and documents
 * @param dir - Output directory path (e.g., `.agents/skills`)
 *
 * @example
 * ```typescript
 * import { exportToDisk, skillsTable, referencesTable } from '@epicenter/skills'
 * import { defineWorkspace, createWorkspace } from '@epicenter/workspace'
 *
 * const ws = createWorkspace(defineWorkspace({
 *   id: 'epicenter.skills',
 *   tables: { skills: skillsTable, references: referencesTable },
 *   kv: {},
 * }))
 *
 * // Export all skills to .agents/skills/ for agent consumption
 * await exportToDisk(ws, '.agents/skills')
 * ```
 */
export async function exportToDisk(
	workspace: SkillsWorkspaceClient,
	dir: string,
): Promise<void> {
	const skills = workspace.tables.skills.getAllValid();
	const skillNames = new Set(skills.map((s) => s.name));

	// Export each skill
	for (const skill of skills) {
		const skillDir = join(dir, skill.name);
		await mkdir(skillDir, { recursive: true });

		// Write SKILL.md
		const instructionsHandle =
			await workspace.documents.skills.instructions.open(skill.id);
		const instructions = instructionsHandle.read();
		const skillMd = serializeSkillMd(skill, instructions);
		await writeFile(join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

		// Write references
		const refs = workspace.tables.references.filter(
			(r) => r.skillId === skill.id,
		);
		if (refs.length > 0) {
			const refsDir = join(skillDir, 'references');
			await mkdir(refsDir, { recursive: true });

			for (const ref of refs) {
				const contentHandle =
					await workspace.documents.references.content.open(ref.id);
				const content = serializeReferenceMd(contentHandle.read());
				await writeFile(join(refsDir, ref.path), content, 'utf-8');
			}
		}
	}

	// Clean up folders for deleted skills
	const existingDirs = await readdir(dir, { withFileTypes: true }).catch(
		() => [],
	);
	for (const entry of existingDirs) {
		if (entry.isDirectory() && !skillNames.has(entry.name)) {
			await rm(join(dir, entry.name), { recursive: true, force: true });
		}
	}
}
