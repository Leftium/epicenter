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

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	createWorkspace,
	defineMutation,
	defineWorkspace,
	generateId,
} from '@epicenter/workspace';
import type { Static } from 'typebox';
import { Type } from 'typebox';
import { parseSkillMd } from './parse.js';
import { serializeSkillMd } from './serialize.js';
import type { Skill } from './tables.js';
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
		 * across machines. If two skills in the same batch collide on id, the
		 * second gets a fresh one and its SKILL.md is rewritten.
		 *
		 * References in `references/*.md` subdirectories are imported with
		 * deterministic IDs derived from `skillId + filename`—no ephemeral IDs,
		 * no matching needed.
		 */
		importFromDisk: defineMutation({
			description: 'Import skills from an agentskills.io-compliant directory',
			input: DirInput,
			handler: async ({ dir }: Static<typeof DirInput>) => {
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

					if (
						parsedSkill.id !== undefined &&
						!seenIds.has(parsedSkill.id)
					) {
						skillId = parsedSkill.id;
					} else {
						skillId = generateId();
					}
					seenIds.add(skillId);

					const skill = {
						...parsedSkill,
						id: skillId,
						updatedAt: Date.now(),
					} satisfies Skill;
					client.tables.skills.set(skill);

					// Write back SKILL.md with the id baked into metadata so
					// future imports on any machine get the same id
					if (needsWriteBack) {
						const updatedMd = serializeSkillMd(skill, instructions);
						await writeFile(skillMdPath, updatedMd, 'utf-8');
					}

					const instructionsHandle =
						await client.documents.skills.instructions.open(skillId);
					instructionsHandle.write(instructions);

					// Import references
					const refsPath = join(skillPath, 'references');
					const hasRefsDir = await stat(refsPath)
						.then((s) => s.isDirectory())
						.catch(() => false);
					if (hasRefsDir) {
						const refFiles = await readdir(refsPath);
						const mdFiles = refFiles.filter((f) => f.endsWith('.md'));

						for (const fileName of mdFiles) {
							const refContent = await readFile(
								join(refsPath, fileName),
								'utf-8',
							);
							const refId = deriveReferenceId(skillId, fileName);

							client.tables.references.set({
								id: refId,
								skillId,
								path: fileName,
								updatedAt: Date.now(),
								_v: 1 as const,
							});

							const contentHandle =
								await client.documents.references.content.open(refId);
							contentHandle.write(refContent);
						}
					}
				}
			},
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
			handler: async ({ dir }: Static<typeof DirInput>) => {
				const skills = client.tables.skills.getAllValid();
				const skillNames = new Set(skills.map((s) => s.name));

				for (const skill of skills) {
					const skillDir = join(dir, skill.name);
					await mkdir(skillDir, { recursive: true });

					// Write SKILL.md
					const instructionsHandle =
						await client.documents.skills.instructions.open(skill.id);
					const instructions = instructionsHandle.read();
					const skillMd = serializeSkillMd(skill, instructions);
					await writeFile(join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

					// Write references
					const refs = client.tables.references.filter(
						(r) => r.skillId === skill.id,
					);
					if (refs.length > 0) {
						const refsDir = join(skillDir, 'references');
						await mkdir(refsDir, { recursive: true });

						for (const ref of refs) {
							const contentHandle =
								await client.documents.references.content.open(
									ref.id,
								);
							const content = contentHandle.read();
							await writeFile(
								join(refsDir, ref.path),
								content,
								'utf-8',
							);
						}
					}
				}

				// Clean up folders for deleted skills
				const existingDirs = await readdir(dir, {
					withFileTypes: true,
				}).catch(() => []);
				for (const entry of existingDirs) {
					if (entry.isDirectory() && !skillNames.has(entry.name)) {
						await rm(join(dir, entry.name), {
							recursive: true,
							force: true,
						});
					}
				}
			},
		}),
	}));
}

const REFERENCE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Derive a deterministic 10-char ID from `skillId + reference path`.
 *
 * Uses SHA-256, then maps each byte to the same `[a-z0-9]` alphabet
 * used by `generateId()`. Renaming a reference file naturally creates
 * a new ID—the old file is conceptually a different reference.
 */
function deriveReferenceId(skillId: string, path: string): string {
	const hash = createHash('sha256').update(`${skillId}:${path}`).digest();
	let result = '';
	for (let i = 0; i < 10; i++) {
		const byte = hash[i] ?? 0;
		result += REFERENCE_ID_ALPHABET[byte % REFERENCE_ID_ALPHABET.length];
	}
	return result;
}
