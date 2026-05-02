import {
	createReferenceContentDoc,
	createSkillInstructionsDoc,
	createSkillsActions,
	referenceContentDocGuid,
	skillInstructionsDocGuid,
} from '@epicenter/skills';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	createBrowserDocumentFamily,
} from '@epicenter/workspace';
import { clearDocument } from 'y-indexeddb';
import { openSkills as openSkillsDoc } from './index.js';

export function openSkillsBrowser() {
	const doc = openSkillsDoc();
	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const instructionsDocs = createBrowserDocumentFamily(
		{
			ids() {
				return doc.tables.skills.getAllValid().map((skill) => skill.id);
			},
			create(skillId: string) {
				const instructionsDoc = createSkillInstructionsDoc({
					skillId,
					workspaceId: doc.ydoc.guid,
					skillsTable: doc.tables.skills,
					attachPersistence: attachIndexedDb,
				});

				return {
					...instructionsDoc,
					persistence: instructionsDoc.persistence as ReturnType<
						typeof attachIndexedDb
					>,
					sync: null,
				};
			},
			clearLocalData(skillId: string) {
				return clearDocument(
					skillInstructionsDocGuid({
						workspaceId: doc.ydoc.guid,
						skillId,
					}),
				);
			},
		},
		{ gcTime: 5_000 },
	);

	const referenceDocs = createBrowserDocumentFamily(
		{
			ids() {
				return doc.tables.references
					.getAllValid()
					.map((reference) => reference.id);
			},
			create(referenceId: string) {
				const referenceDoc = createReferenceContentDoc({
					referenceId,
					workspaceId: doc.ydoc.guid,
					referencesTable: doc.tables.references,
					attachPersistence: attachIndexedDb,
				});

				return {
					...referenceDoc,
					persistence: referenceDoc.persistence as ReturnType<
						typeof attachIndexedDb
					>,
					sync: null,
				};
			},
			clearLocalData(referenceId: string) {
				return clearDocument(
					referenceContentDocGuid({
						workspaceId: doc.ydoc.guid,
						referenceId,
					}),
				);
			},
		},
		{ gcTime: 5_000 },
	);

	const actions = createSkillsActions({
		tables: doc.tables,
		async readInstructions(skillId) {
			await using handle = instructionsDocs.open(skillId);
			await handle.whenReady;
			return handle.instructions.read();
		},
		async readReference(referenceId) {
			await using handle = referenceDocs.open(referenceId);
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
			await instructionsDocs.clearLocalData();
			await referenceDocs.clearLocalData();
			await idb.clearLocal();
		},
		[Symbol.dispose]() {
			instructionsDocs[Symbol.dispose]();
			referenceDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
		},
	};
}
