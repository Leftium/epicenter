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
import {
	browserStorage,
	createTestStorage,
	opfsOf,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import {
	type Entry,
	type Stage,
	type VocabFolder,
	type VocabTables,
	vocabFolder,
} from './data.js';
import type { EntriesState } from './entries.svelte.js';
import { VOCAB_FOLDER_ID } from './folder.js';

/** Let the folder answer until `done` holds. */
export async function until(done: () => boolean, what: string) {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (done()) return;
		await Bun.sleep(1);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Edit a word the way its card does: type the note, then press a stage, and
 * wait until the saves land and the list shows them. Answers why it was not
 * saved, or null.
 */
export async function editWord(
	entries: EntriesState,
	id: string,
	edit: { note?: string; stage?: Stage },
): Promise<string | null> {
	const word = entries.word(id);
	await word.open();
	if (edit.note !== undefined) {
		const refused = word.inputNote(edit.note);
		if (refused !== null) return refused;
	}
	if (edit.stage !== undefined) {
		const failed = await word.setStage(edit.stage);
		if (failed !== null) return failed;
	}
	await until(() => word.save?.status !== 'saving', 'the word to save');
	const { save } = word;
	if (save?.status === 'failed') return `not saved: ${save.error.message}`;
	await until(
		() =>
			entries.entries.find((entry) => entry.id === id)?.file.text ===
			word.row?.text,
		'the list to show the saved word',
	);
	return null;
}

/**
 * The word as the list shows it now, by its text or its ID: what a Delete
 * press fixes as the learner's choice.
 */
export function listed(entries: EntriesState, key: string): Entry {
	const entry = entries.entries.find(
		(candidate) => candidate.text === key || candidate.id === key,
	);
	if (entry === undefined) throw new Error(`${key} is not listed`);
	return entry;
}

/** What the words list is given from an open folder, as the page gives it. */
export const entriesOf = (folder: VocabFolder) => ({
	table: folder.tables.entries,
});

/**
 * One browser's storage, and every folder handle opened over it. `opfs` is
 * the stand-in tree itself: its `faults` hold or fail the next write, and
 * `put` and `drop` change a file the way another program would, with no
 * change hint.
 */
export function createBrowser() {
	const tree = createTestStorage();
	const storage = browserStorage(tree);
	const opened: VocabFolder[] = [];
	const opfs = opfsOf(tree);
	/** The stand-in's path for a folder path. */
	const located = (path: string) => {
		const found = [...opfs.files().keys()].find(
			(key) => key.endsWith(`/${path}`) && !key.includes('/.git/'),
		);
		if (found === undefined) throw new Error(`No file at ${path}`);
		return found;
	};
	return {
		opfs,
		/** Write `bytes` at a folder path as another program would. */
		put(path: string, content: string | Uint8Array) {
			opfs.put(
				located(path),
				typeof content === 'string'
					? new TextEncoder().encode(content)
					: content,
			);
		},
		/** Remove a folder path as another program would. */
		drop(path: string) {
			opfs.drop(located(path));
		},
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
 * `edit` and `get` wait before they read anything; `delete` runs for real
 * first, so the file is gone, and its answer waits. `deletes` counts deletes
 * sent. While `refusing` names `edit` or `get`,
 * that call answers with a storage failure and reads nothing, the way a
 * browser store that cannot read answers.
 */
export function heldEntries(table: VocabTables['entries']) {
	const holds: {
		edit?: Promise<void>;
		get?: Promise<void>;
		deleteAnswer?: Promise<void>;
		refusing: Set<'edit' | 'get'>;
		deletes: number;
	} = { refusing: new Set(), deletes: 0 };
	const refused = (stem: string) =>
		FileError.Io({
			path: `entries/${stem}.md`,
			operation: 'read',
			cause: new Error('storage refused'),
		});
	const held: VocabTables['entries'] = {
		...table,
		async edit(stem, options) {
			await holds.edit;
			if (holds.refusing.has('edit')) return refused(stem);
			return table.edit(stem, options);
		},
		async get(stem) {
			await holds.get;
			if (holds.refusing.has('get')) return refused(stem);
			return table.get(stem);
		},
		async delete(stem, options) {
			holds.deletes++;
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
