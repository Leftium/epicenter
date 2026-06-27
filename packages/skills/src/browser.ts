/**
 * @fileoverview Browser entry for the shared skills workspace.
 *
 * Exports `openSkillsBrowser`: a browser workspace opener with IndexedDB
 * persistence and a BroadcastChannel for cross-tab sync. Instruction and
 * reference bodies are opened lazily through guid-keyed disposable caches,
 * each child doc backed by its own IndexedDB database.
 *
 * Uses the same `SKILLS_WORKSPACE_ID` guid as the node entry, so data authored
 * on either side targets the same logical Y.Doc.
 *
 * @example
 * ```typescript
 * using skills = openSkillsBrowser();
 * await skills.idb.whenLoaded;
 * const catalog = skills.actions.list_skills();
 *
 * // Editor binding (e.g. via @epicenter/svelte `fromDisposableCache`):
 * using handle = skills.instructionsDocs.open(skillId);
 * editor.bind(handle.instructions.binding);
 * ```
 *
 * @module
 */

import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachPlainText,
	createDisposableCache,
	InstantString,
	onLocalUpdate,
} from '@epicenter/workspace';
import { clearDocument } from 'y-indexeddb';
import * as Y from 'yjs';
import { createSkillsActions } from './skills-actions.js';
import { createSkills } from './workspace.js';

/**
 * Open the shared skills workspace for a browser runtime.
 *
 * The root doc gets IndexedDB persistence plus a BroadcastChannel for cross-tab
 * sync. Instruction and reference bodies are child docs whose guids the
 * workspace owns (`tables.skills.docs.instructions.guid`,
 * `tables.references.docs.content.guid`); each is opened lazily through its own
 * guid-keyed cache and backed by a per-doc IndexedDB database.
 */
export function openSkillsBrowser() {
	const doc = createSkills();
	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const instructionsDocs = createDisposableCache((skillId: string) => {
		const ydoc = new Y.Doc({
			guid: doc.tables.skills.docs.instructions.guid(skillId),
			gc: true,
		});
		onLocalUpdate(ydoc, () =>
			doc.tables.skills.update(skillId, { updatedAt: InstantString.now() }),
		);
		const childIdb = attachIndexedDb(ydoc);
		return {
			ydoc,
			instructions: attachPlainText(ydoc),
			idb: childIdb,
			/**
			 * child disposer rejections do not propagate; bundle.wipe() relies on
			 * IDB's deleteDatabase native blocking as belt-and-suspenders for
			 * storage deletion.
			 */
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});
	const referenceDocs = createDisposableCache((referenceId: string) => {
		const ydoc = new Y.Doc({
			guid: doc.tables.references.docs.content.guid(referenceId),
			gc: true,
		});
		onLocalUpdate(ydoc, () =>
			doc.tables.references.update(referenceId, {
				updatedAt: InstantString.now(),
			}),
		);
		const childIdb = attachIndexedDb(ydoc);
		return {
			ydoc,
			content: attachPlainText(ydoc),
			idb: childIdb,
			/**
			 * child disposer rejections do not propagate; bundle.wipe() relies on
			 * IDB's deleteDatabase native blocking as belt-and-suspenders for
			 * storage deletion.
			 */
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});

	const actions = createSkillsActions({
		tables: doc.tables,
		async readInstructions(skillId) {
			using handle = instructionsDocs.open(skillId);
			await handle.idb.whenLoaded;
			return handle.instructions.read();
		},
		async readReference(referenceId) {
			using handle = referenceDocs.open(referenceId);
			await handle.idb.whenLoaded;
			return handle.content.read();
		},
	});

	return {
		...doc,
		idb,
		whenReady: idb.whenLoaded,
		instructionsDocs,
		referenceDocs,
		actions,
		async wipe() {
			instructionsDocs[Symbol.dispose]();
			referenceDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
			await idb.whenDisposed;
			await Promise.all([
				// Skill instruction docs use their own IndexedDB document names.
				...doc.tables.skills
					.scan()
					.rows.map((skill) =>
						clearDocument(doc.tables.skills.docs.instructions.guid(skill.id)),
					),
				// Reference content docs use their own IndexedDB document names.
				...doc.tables.references
					.scan()
					.rows.map((reference) =>
						clearDocument(
							doc.tables.references.docs.content.guid(reference.id),
						),
					),
				// The workspace IndexedDB helper only clears the root doc.
				idb.clearLocal(),
			]);
		},
		[Symbol.dispose]() {
			instructionsDocs[Symbol.dispose]();
			referenceDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
		},
	};
}
