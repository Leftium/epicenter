/**
 * @fileoverview Filesystem ↔ workspace bridge for agent skills.
 *
 * Two operations:
 * - `importFromDisk` scans agentskills.io-compliant folders and upserts rows
 *   into workspace tables.
 * - `exportToDisk` reads workspace tables and writes agentskills.io-compliant
 *   folders to disk.
 *
 * Both share the `SkillsWorkspaceClient` duck type that defines the minimal
 * workspace surface they need.
 *
 * @module
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateId } from '@epicenter/workspace';
import { parseReferenceMd, parseSkillMd } from './parse.js';
import { serializeSkillMd } from './serialize.js';
import type { Reference, Skill } from './tables.js';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════════════════════════
// Import
// ════════════════════════════════════════════════════════════════════════════

/**
 * Import skills from an agentskills.io-compliant directory into workspace tables.
 *
 * Scans `dir` for subdirectories containing a `SKILL.md` file. For each skill:
 *
 * 1. Parses SKILL.md frontmatter into a skills table row
 * 2. Uses the persisted `metadata.id` from SKILL.md (falls back to `generateId()`
 *    for brand-new skills that have never been exported)
 * 3. Upserts the skill row and writes the instructions document
 * 4. Enumerates `references/*.md` files into `referencesTable` rows with documents
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

		const skillId = parsedSkill.id ?? generateId();

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

// ════════════════════════════════════════════════════════════════════════════
// Export
// ════════════════════════════════════════════════════════════════════════════

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
				const content = contentHandle.read();
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
