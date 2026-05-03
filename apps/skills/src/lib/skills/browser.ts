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
	createDisposableCache,
} from '@epicenter/workspace';
import { clearDocument } from 'y-indexeddb';
import { openSkills as openSkillsDoc } from './index.js';

export function openSkillsBrowser() {
	const doc = openSkillsDoc();
	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const instructionsDocs = createDisposableCache(
		(skillId: string) => {
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
			};
		},
		{ gcTime: 5_000 },
	);
	async function clearInstructionsLocalData() {
		await Promise.all(
			doc.tables.skills.getAllValid().map((skill) =>
				clearDocument(
					skillInstructionsDocGuid({
						workspaceId: doc.ydoc.guid,
						skillId: skill.id,
					}),
				),
			),
		);
	}

	const referenceDocs = createDisposableCache(
		(referenceId: string) => {
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
			};
		},
		{ gcTime: 5_000 },
	);
	async function clearReferenceLocalData() {
		await Promise.all(
			doc.tables.references.getAllValid().map((reference) =>
				clearDocument(
					referenceContentDocGuid({
						workspaceId: doc.ydoc.guid,
						referenceId: reference.id,
					}),
				),
			),
		);
	}

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
			await clearInstructionsLocalData();
			await clearReferenceLocalData();
			await idb.clearLocal();
		},
		[Symbol.dispose]() {
			instructionsDocs[Symbol.dispose]();
			referenceDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
		},
	};
}
