/**
 * @fileoverview Filesystem ↔ workspace bridge for agent skills.
 *
 * Internal module—consumers use `createSkillsWorkspace()` which exposes
 * these as workspace actions. The standalone functions are kept as the
 * implementation layer so they can be tested and composed independently.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateId } from '@epicenter/workspace';
import { parseReferenceMd, parseSkillMd } from './parse.js';
import { serializeSkillMd } from './serialize.js';
import type { Reference, Skill } from './tables.js';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

/** Minimal workspace client shape required by `importFromDisk` and `exportToDisk`. */
type SkillsWorkspaceClient = {
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
 * 1. Parses SKILL.md frontmatter — uses `metadata.id` if present
 * 2. If `metadata.id` is missing (new skill or pre-metadata legacy), generates
 *    a new id and **writes it back** to SKILL.md so future imports are stable
 * 3. If `metadata.id` collides with another skill in this import batch,
 *    regenerates and writes back to prevent silent overwrites
 * 4. Upserts the skill row and writes the instructions document
 * 5. Enumerates `references/*.md` files with deterministic ids derived from
 *    `skillId + path` (no ephemeral ids, no matching needed)
 *
 * @param dir - Path to the skills directory (e.g., `.agents/skills`)
 * @param workspace - A workspace client with skills/references tables and documents
 *
 * @example
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills'
 *
 * const ws = createSkillsWorkspace()
 * await ws.actions.importFromDisk({ dir: '.agents/skills' })
 * ```
 */
export async function importFromDisk(
	dir: string,
	workspace: SkillsWorkspaceClient,
): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true });
	const skillDirs = entries.filter((e) => e.isDirectory());
	const seenIds = new Set<string>();

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

		// Resolve id: use parsed id, or generate a new one for
		// brand-new / pre-metadata skills
		let skillId: string;
		const needsWriteBack =
			parsedSkill.id === undefined || seenIds.has(parsedSkill.id);

		if (parsedSkill.id !== undefined && !seenIds.has(parsedSkill.id)) {
			skillId = parsedSkill.id;
		} else {
			skillId = generateId();
		}
		seenIds.add(skillId);

		const skill: Skill = {
			...parsedSkill,
			id: skillId,
			updatedAt: Date.now(),
		};
		workspace.tables.skills.set(skill);

		// Write back SKILL.md with the id baked into metadata so
		// future imports on any machine get the same id
		if (needsWriteBack) {
			const updatedMd = serializeSkillMd(skill, instructions);
			await writeFile(skillMdPath, updatedMd, 'utf-8');
		}

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
 * Reference ids are derived deterministically from `skillId + path`,
 * so they survive round-trips without needing to be stored in the file.
 * Same skill + same filename always produces the same reference id.
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

	for (const fileName of mdFiles) {
		const rawContent = await readFile(join(refsPath, fileName), 'utf-8');
		const { reference: parsedRef, content } = parseReferenceMd(
			skillId,
			fileName,
			rawContent,
		);

		const refId = deriveReferenceId(skillId, fileName);

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

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Derive a deterministic 10-char id from skillId + reference path.
 *
 * Uses SHA-256 to hash the composite key, then maps each byte to the
 * same `[a-z0-9]` alphabet used by `generateId()`. This ensures:
 * - Same skill + same filename always produces the same reference id
 * - No need to persist reference ids in files or match by path
 * - Renaming a reference file naturally creates a new id (intended—the
 *   old file is conceptually a different reference)
 */
function deriveReferenceId(skillId: string, path: string): string {
	const hash = createHash('sha256').update(`${skillId}:${path}`).digest();
	let result = '';
	for (let i = 0; i < 10; i++) {
		const byte = hash[i] ?? 0;
		result += ALPHABET[byte % ALPHABET.length];
	}
	return result;
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
 * import { createSkillsWorkspace } from '@epicenter/skills'
 *
 * const ws = createSkillsWorkspace()
 * await ws.actions.exportToDisk({ dir: '.agents/skills' })
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
