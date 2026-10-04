/**
 * Test helper: Vocab's real browser folder over the in-memory OPFS stand-in.
 *
 * `open` opens the folder the way the page does, under `VOCAB_FOLDER_ID`, so
 * opening again in the same browser is a reload or another tab. A
 * gated table is the real table with one refusal or delay put in front of it,
 * the way a full or slow browser store answers.
 */
import { FileError } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import { testBrowserStorage } from '../../../../packages/folder/src/browser-storage.test-support.js';
import {
	type Stage,
	type VocabFolder,
	type VocabTables,
	vocabFolder,
} from './data.js';
import type { EntriesState } from './entries.svelte.js';
import { VOCAB_FOLDER_ID } from './folder.js';

/**
 * Edit a word the way its card does: type the note and leave the field, then
 * press a stage. Answers why it was not saved, or null.
 */
export async function editWord(
	entries: EntriesState,
	id: string,
	edit: { note?: string; stage?: Stage },
): Promise<string | null> {
	const word = entries.word(id);
	await word.open();
	if (edit.note !== undefined) {
		word.inputNote(edit.note);
		const failed = await word.blur();
		if (failed !== null) return failed;
	}
	return edit.stage === undefined ? null : word.setStage(edit.stage);
}

/** One browser's storage, and every folder handle opened over it. */
export function createBrowser() {
	const storage = testBrowserStorage();
	const opened: VocabFolder[] = [];
	return {
		/** Open Vocab's folder in this browser: a first visit, a reload, or another tab. */
		async open(): Promise<VocabFolder> {
			const folder = expectOk(
				await openFolder({
					id: VOCAB_FOLDER_ID,
					definition: vocabFolder,
					browser: { commitOnEdit: false, ...storage },
				}),
			);
			opened.push(folder);
			return folder;
		},
		async [Symbol.asyncDispose]() {
			for (const folder of opened.splice(0)) await folder.close();
		},
	};
}

/** The exact text of a saved file, or `undefined` when there is none. */
export async function fileText(
	folder: VocabFolder,
	path: string,
): Promise<string | undefined> {
	const { data: file, error: readError } = await folder.files.read(path);
	return readError === null ? new TextDecoder().decode(file.bytes) : undefined;
}

/** The paths of every file in one table's directory, sorted. */
export async function tableFiles(
	folder: VocabFolder,
	table: keyof VocabTables,
): Promise<string[]> {
	const listed = expectOk(await folder.files.list());
	return listed.files
		.map((file) => file.path)
		.filter((path) => path.startsWith(`${table}/`))
		.sort();
}

/**
 * The real entries table with its word operations held where a test says.
 * `edit` waits before it reads anything. `replace` and `delete` run for real
 * first, so the file has changed, and their answers wait.
 */
export function heldEntries(table: VocabTables['entries']) {
	const holds: {
		edit?: Promise<void>;
		replaceAnswer?: Promise<void>;
		deleteAnswer?: Promise<void>;
	} = {};
	const held: VocabTables['entries'] = {
		...table,
		async edit(stem, options) {
			await holds.edit;
			return table.edit(stem, options);
		},
		async replace(stem, text, options) {
			const replaced = await table.replace(stem, text, options);
			await holds.replaceAnswer;
			return replaced;
		},
		async delete(stem, options) {
			const deleted = await table.delete(stem, options);
			await holds.deleteAnswer;
			return deleted;
		},
	};
	return { holds, table: held };
}

/**
 * The real table behind a gate. While `failing`, `create` and `list` answer
 * with a storage failure and write or read nothing. A held operation waits
 * for its promise, then runs for real. A lost receipt and a held listing run
 * for real first: the file is written, or the listing read, before the answer
 * is refused or delayed.
 */
export function gated<TTable extends VocabTables[keyof VocabTables]>(
	table: TTable,
) {
	const gate = {
		failing: false,
		/** The next create really lands, and its answer is lost as a refusal. */
		losingReceipt: false,
		heldCreate: undefined as Promise<void> | undefined,
		heldList: undefined as Promise<void> | undefined,
		/** A listing is read at once and delivered only after this resolves. */
		heldListing: undefined as Promise<void> | undefined,
		creates: 0,
		lists: 0,
	};
	const refused = (operation: string) =>
		FileError.Io({
			path: table.name,
			operation,
			cause: new Error('storage refused'),
		});
	return {
		gate,
		table: {
			...table,
			async create(input: Parameters<TTable['create']>[0]) {
				await gate.heldCreate;
				gate.creates++;
				if (gate.failing) return refused('write');
				const created = await table.create(input as never);
				if (!gate.losingReceipt) return created;
				gate.losingReceipt = false;
				return refused('confirm the write of');
			},
			async list() {
				// Read when the listing is asked for, so a test can hold one listing.
				const { heldListing } = gate;
				gate.lists++;
				await gate.heldList;
				if (gate.failing) return refused('list');
				const listed = await table.list();
				await heldListing;
				return listed;
			},
		} as TTable,
	};
}
