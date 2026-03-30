/**
 * @fileoverview Import skills from agentskills.io-compliant folders into workspace tables.
 *
 * Scans a directory for skill folders containing SKILL.md files, parses them,
 * and upserts rows into the workspace. Also imports `references/` files.
 * Matches by `name` on re-import to update existing rows rather than creating
 * duplicates.
 *
 * @module
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { generateId } from '@epicenter/workspace';
import { parseReferenceMd, parseSkillMd } from './parse.js';
import type { SkillsWorkspaceClient } from './types.js';

/**
 * Import skills from an agentskills.io-compliant directory into workspace tables.
 *
 * Scans `dir` for subdirectories containing a `SKILL.md` file. For each skill:
 *
 * 1. Parses SKILL.md frontmatter into a skills table row
 * 2. Matches existing skills by `name` to avoid duplicates on re-import
 * 3. Upserts the skill row (new id for first import, existing id for updates)
 * 4. Writes the instructions markdown to the skill's document handle
 * 5. Enumerates `references/*.md` files into `referencesTable` rows with documents
 *
 * Skips `scripts/` and `assets/` directories (deferred to v2).
 *
 * @param dir - Path to the skills directory (e.g., `.agents/skills`)
 * @param workspace - A workspace client with skills/references tables and documents
 *
 * @example
 * ```typescript
 * import { importFromDisk, skillsTable, referencesTable } from '@epicenter/skills'
 * import { defineWorkspace, createWorkspace } from '@epicenter/workspace'
 *
 * const ws = createWorkspace(defineWorkspace({
 *   id: 'epicenter.skills',
 *   tables: { skills: skillsTable, references: referencesTable },
 *   kv: {},
 * }))
 *
 * // First import — creates rows with new nanoid IDs
 * await importFromDisk('.agents/skills', ws)
 *
 * // Re-import after editing SKILL.md in a text editor — updates existing rows
 * await importFromDisk('.agents/skills', ws)
 * ```
 */
export async function importFromDisk(
	dir: string,
	workspace: SkillsWorkspaceClient,
): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true });
	const skillDirs = entries.filter((e) => e.isDirectory());

	for (const skillDir of skillDirs) {
		const skillPath = join(dir, skillDir.name);
		const skillMdPath = join(skillPath, 'SKILL.md');

		// Skip directories without SKILL.md
		const hasSkillMd = await stat(skillMdPath)
			.then((s) => s.isFile())
			.catch(() => false);
		if (!hasSkillMd) continue;

		const rawContent = await readFile(skillMdPath, 'utf-8');
		const { skill: parsedSkill, instructions } = parseSkillMd(
			skillDir.name,
			rawContent,
		);

		// Match by name to support re-import without duplication
		const existing = workspace.tables.skills.find(
			(s) => s.name === skillDir.name,
		);
		const skillId = existing?.id ?? generateId();

		workspace.tables.skills.set({
			...parsedSkill,
			id: skillId,
			// Preserve updatedAt on re-import only if content hasn't changed
			updatedAt: Date.now(),
		});

		const instructionsHandle =
			await workspace.documents.skills.instructions.open(skillId);
		instructionsHandle.write(instructions);

		// Import references
		await importReferences(workspace, skillId, skillPath);
	}
}

/**
 * Import all `references/*.md` files for a single skill.
 *
 * Matches existing references by `skillId + path` to avoid duplicates on
 * re-import. New files get new IDs; existing files get their content updated.
 */
async function importReferences(
	workspace: SkillsWorkspaceClient,
	skillId: string,
	skillPath: string,
): Promise<void> {
	const refsPath = join(skillPath, 'references');
	const hasRefsDir = await stat(refsPath)
		.then((s) => s.isDirectory())
		.catch(() => false);
	if (!hasRefsDir) return;

	const refFiles = await readdir(refsPath);
	const mdFiles = refFiles.filter((f) => f.endsWith('.md'));
	const existingRefs = workspace.tables.references.filter(
		(r) => r.skillId === skillId,
	);

	for (const fileName of mdFiles) {
		const rawContent = await readFile(join(refsPath, fileName), 'utf-8');
		const { reference: parsedRef, content } = parseReferenceMd(
			skillId,
			fileName,
			rawContent,
		);

		// Match by skillId + path to support re-import
		const existing = existingRefs.find((r) => r.path === fileName);
		const refId = existing?.id ?? generateId();

		workspace.tables.references.set({
			...parsedRef,
			id: refId,
			updatedAt: Date.now(),
		});

		const contentHandle =
			await workspace.documents.references.content.open(refId);
		contentHandle.write(content);
	}
}
