/**
 * @fileoverview Isomorphic skills workspace factory.
 *
 * `createSkillsWorkspace()` opens the shared `epicenter.skills` Y.Doc,
 * creates per-skill instruction and reference content-doc factories, and
 * attaches the three read actions for progressive skill disclosure. The
 * returned bundle is the standard `WorkspaceBundle` plus `actions`,
 * `instructionsDocs`, and `referenceDocs`.
 *
 * Apps layer persistence and sync on top via `attachIndexedDb` (browser) or
 * their chosen persistence. Safe to import in any runtime (browser, Node,
 * Bun) — persistence is the caller's responsibility.
 *
 * For disk I/O actions (importFromDisk, exportToDisk), import from
 * `@epicenter/skills/node` instead.
 *
 * @module
 */

import { defineQuery } from '@epicenter/workspace';
import Type from 'typebox';
import { skillsWorkspace as skillsFactory } from './definition.js';
import { createReferenceContentDocs } from './reference-content-docs.js';
import { createSkillInstructionsDocs } from './skill-instructions-docs.js';

export { skillsWorkspace } from './definition.js';

/**
 * Open the shared skills workspace, wire the per-skill document factories,
 * and attach the three read actions. Returns the `WorkspaceBundle` augmented
 * with `actions`, `instructionsDocs`, and `referenceDocs`.
 *
 * @param opts.docPersistence
 *   Whether per-skill content docs attach IndexedDB automatically.
 *   Defaults to `'indexeddb'`. Pass `'none'` for Node / tests.
 *
 * @example Browser
 * ```typescript
 * import { attachIndexedDb } from '@epicenter/document';
 * import { createSkillsWorkspace } from '@epicenter/skills';
 *
 * const base = createSkillsWorkspace();
 * const idb = attachIndexedDb(base.ydoc);
 * export const workspace = Object.assign(base, {
 *   idb,
 *   whenReady: idb.whenLoaded,
 * });
 * ```
 */
export function createSkillsWorkspace(
	opts: { docPersistence?: 'indexeddb' | 'none' } = {},
) {
	const base = skillsFactory.open('epicenter.skills');
	const persistence = opts.docPersistence ?? 'indexeddb';
	const instructionsDocs = createSkillInstructionsDocs({
		workspaceId: base.ydoc.guid,
		skillsTable: base.tables.skills,
		persistence,
	});
	const referenceDocs = createReferenceContentDocs({
		workspaceId: base.ydoc.guid,
		referencesTable: base.tables.references,
		persistence,
	});

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

	const actions = {
		/**
		 * List all skills as lightweight catalog entries — no docs opened.
		 */
		listSkills: defineQuery({
			description: 'List all skills (id, name, description)',
			handler: () =>
				base.tables.skills
					.getAllValid()
					.map((s) => ({ id: s.id, name: s.name, description: s.description }))
					.sort((a, b) => a.name.localeCompare(b.name)),
		}),

		/** Get a single skill's metadata and instructions. Opens one Y.Doc. */
		getSkill: defineQuery({
			description: 'Get skill metadata and instructions by ID',
			input: Type.Object({ id: Type.String() }),
			handler: async ({ id }) => {
				const skill = base.tables.skills.find((s) => s.id === id);
				if (!skill) return null;
				const instructions = await readInstructions(id);
				return { skill, instructions };
			},
		}),

		/** Get a skill with full instructions and all reference content. */
		getSkillWithReferences: defineQuery({
			description: 'Get skill with instructions and all reference content',
			input: Type.Object({ id: Type.String() }),
			handler: async ({ id }) => {
				const skill = base.tables.skills.find((s) => s.id === id);
				if (!skill) return null;
				const instructions = await readInstructions(id);
				const refs = base.tables.references.filter((r) => r.skillId === id);
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
	};

	return Object.assign(base, { actions, instructionsDocs, referenceDocs });
}
