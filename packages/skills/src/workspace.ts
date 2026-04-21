/**
 * @fileoverview Isomorphic workspace factory for agent skills.
 *
 * `createSkillsWorkspace()` returns the workspace builder alongside the
 * shared per-skill document factories (`instructionsDocs`, `referenceDocs`).
 * This is safe to import in any runtime (browser, Node, Bun).
 *
 * For disk I/O actions (importFromDisk, exportToDisk), import from
 * `@epicenter/skills/node` instead — that subpath returns a pre-built
 * workspace with server-side actions attached.
 *
 * @module
 */

import { createWorkspace, defineQuery } from '@epicenter/workspace';
import Type from 'typebox';
import { skillsDefinition } from './definition.js';
import { createReferenceContentDocs } from './reference-content-docs.js';
import { createSkillInstructionsDocs } from './skill-instructions-docs.js';

export { skillsDefinition } from './definition.js';

/**
 * Create an isomorphic skills workspace with shared document factories.
 *
 * Returns `{ workspace, instructionsDocs, referenceDocs }`. Apps chain
 * `.withExtension()` on `workspace` to add persistence/sync, and open
 * per-skill Y.Docs via `instructionsDocs.open(id)` / `referenceDocs.open(id)`.
 * Both factories are already wired into the workspace's read actions, so
 * components and actions share the same handle cache.
 *
 * Includes three read actions for progressive skill disclosure:
 * - `listSkills()` — catalog entries (cheap, no docs opened)
 * - `getSkill({ id })` — metadata + instructions (opens one Y.Doc)
 * - `getSkillWithReferences({ id })` — full skill with all references (opens 1 + N Y.Docs)
 *
 * @example Browser
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills'
 *
 * const { workspace, instructionsDocs, referenceDocs } = createSkillsWorkspace();
 * const ws = workspace.withExtension('persistence', indexeddbPersistence);
 * using h = instructionsDocs.open(skillId);
 * ```
 */
export function createSkillsWorkspace(
	opts: { docPersistence?: 'indexeddb' | 'none' } = {},
) {
	const base = createWorkspace(skillsDefinition);
	const persistence = opts.docPersistence;
	const instructionsDocs = createSkillInstructionsDocs(base, { persistence });
	const referenceDocs = createReferenceContentDocs(base, { persistence });

	async function readInstructions(id: string): Promise<string> {
		using h = instructionsDocs.open(id);
		await h.whenReady;
		return h.instructions.read();
	}

	async function readReference(id: string): Promise<string> {
		using h = referenceDocs.open(id);
		await h.whenReady;
		return h.content.read();
	}

	const workspace = base.withActions((client) => ({
		/**
		 * List all skills as lightweight catalog entries.
		 *
		 * Returns id, name, and description for every valid skill row.
		 * No documents are opened — cheap enough to call on every render
		 * cycle or at agent session startup.
		 */
		listSkills: defineQuery({
			description: 'List all skills (id, name, description)',
			handler: () =>
				client.tables.skills
					.getAllValid()
					.map((s) => ({ id: s.id, name: s.name, description: s.description }))
					.sort((a, b) => a.name.localeCompare(b.name)),
		}),

		/**
		 * Get a single skill's metadata and instructions.
		 *
		 * Opens the skill's instructions document (one Y.Doc) and reads
		 * the full markdown content.
		 */
		getSkill: defineQuery({
			description: 'Get skill metadata and instructions by ID',
			input: Type.Object({ id: Type.String() }),
			handler: async ({ id }) => {
				const skill = client.tables.skills.find((s) => s.id === id);
				if (!skill) return null;
				const instructions = await readInstructions(id);
				return { skill, instructions };
			},
		}),

		/**
		 * Get a skill with its full instructions and all reference content.
		 *
		 * Opens the instructions document plus one content document per
		 * reference — expensive for skills with many references.
		 */
		getSkillWithReferences: defineQuery({
			description: 'Get skill with instructions and all reference content',
			input: Type.Object({ id: Type.String() }),
			handler: async ({ id }) => {
				const skill = client.tables.skills.find((s) => s.id === id);
				if (!skill) return null;
				const instructions = await readInstructions(id);
				const refs = client.tables.references.filter((r) => r.skillId === id);
				const references = await Promise.all(
					refs.map(async (ref) => ({
						path: ref.path,
						content: await readReference(ref.id),
					})),
				);
				return {
					skill,
					instructions,
					references: references.sort((a, b) => a.path.localeCompare(b.path)),
				};
			},
		}),
	}));

	return { workspace, instructionsDocs, referenceDocs };
}
