import {
	createSkillsActions,
	referenceContentDocGuid,
	skillInstructionsDocGuid,
} from '@epicenter/skills';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachPlainText,
	createDisposableCache,
	onLocalUpdate,
} from '@epicenter/workspace';
import { clearDocument } from 'y-indexeddb';
import * as Y from 'yjs';
import { openSkills as openSkillsDoc } from './index.js';

export function openSkillsBrowser() {
	const doc = openSkillsDoc();
	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const instructionsDocs = createDisposableCache(
		(skillId: string) => {
			const ydoc = new Y.Doc({
				guid: skillInstructionsDocGuid({
					workspaceId: doc.ydoc.guid,
					skillId,
				}),
				gc: false,
			});
			onLocalUpdate(ydoc, () =>
				doc.tables.skills.update(skillId, { updatedAt: Date.now() }),
			);
			const persistence = attachIndexedDb(ydoc);
			return {
				ydoc,
				instructions: attachPlainText(ydoc),
				persistence,
				whenReady: persistence.whenLoaded,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		},
		{ gcTime: 5_000 },
	);
	const referenceDocs = createDisposableCache(
		(referenceId: string) => {
			const ydoc = new Y.Doc({
				guid: referenceContentDocGuid({
					workspaceId: doc.ydoc.guid,
					referenceId,
				}),
				gc: false,
			});
			onLocalUpdate(ydoc, () =>
				doc.tables.references.update(referenceId, { updatedAt: Date.now() }),
			);
			const persistence = attachIndexedDb(ydoc);
			return {
				ydoc,
				content: attachPlainText(ydoc),
				persistence,
				whenReady: persistence.whenLoaded,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		},
		{ gcTime: 5_000 },
	);

	const actions = createSkillsActions({
		tables: doc.tables,
		async readInstructions(skillId) {
			using handle = instructionsDocs.open(skillId);
			await handle.whenReady;
			return handle.instructions.read();
		},
		async readReference(referenceId) {
			using handle = referenceDocs.open(referenceId);
			await handle.whenReady;
			return handle.content.read();
		},
	});

	return {
		...doc,
		idb,
		instructionsDocs,
		referenceDocs,
		actions,
		whenReady: idb.whenLoaded,
		async clearLocalData() {
			await Promise.all([
				// Skill instruction docs use their own IndexedDB document names.
				...doc.tables.skills.getAllValid().map((skill) =>
					clearDocument(
						skillInstructionsDocGuid({
							workspaceId: doc.ydoc.guid,
							skillId: skill.id,
						}),
					),
				),
				// Reference content docs use their own IndexedDB document names.
				...doc.tables.references.getAllValid().map((reference) =>
					clearDocument(
						referenceContentDocGuid({
							workspaceId: doc.ydoc.guid,
							referenceId: reference.id,
						}),
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
