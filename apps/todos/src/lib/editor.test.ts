/**
 * Raw Text Editor Tests
 *
 * Drives the real raw draft runes module (compiled with Svelte's module
 * compiler): the plain editor for any text file, and the source editor that
 * repairs a todo row. Both keep the buffer and the accepted baseline separate,
 * save conditionally, and never crash on source they cannot interpret.
 *
 * Key behaviors:
 * - A row's source editor saves text that does not parse exactly as typed,
 *   and its diagnostics are the buffer's, never the saved file's
 * - Saving writes the exact buffer against the captured baseline
 * - Typing during a save stays dirty after the save is accepted
 * - A same-byte observation becomes the baseline without replacing typing
 * - A raw save replaces the baseline's capture, and the capture the folder
 *   returns is the next baseline, with nothing read back
 * - An accepted save's baseline is the text of the bytes sent; a buffer still
 *   at that generation becomes it, so an unpaired surrogate settles and is
 *   not sent again, while newer typing stays as typed
 * - A conflict reads as removed only when the saved file is absent; a saved
 *   file that cannot be read fails the save, keeps the baseline and the
 *   buffer, and a retry repeats the same conditional save
 * - A failed save, or one whose reply was lost, sends nothing more on its
 *   own: newer input stays on screen, and no timer, settle, or move resends
 *   it. Trying again makes one conditional attempt; bytes an unknown save did
 *   land come back as a conflict, and a read of them is never a receipt
 *
 * See also:
 * - `todo-editor.test.ts` for the structured todo editor
 * - `todos.test.ts` for raw text drafts against a real browser folder
 */
import './svelte-modules.test-support.js';
import { afterAll, expect, test } from 'bun:test';
import type {
	CapturedFile,
	FileCapture,
	FileTable,
	FolderFiles,
	TableSnapshot,
} from '@epicenter/folder';
import { FileError, hashBytes, TableError } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { type TodoFields, todosDefinition } from './definition.js';
import type { SavedText } from './editor.svelte.js';
import { EDITABLE_TEXT_LIMIT } from './files.js';

const { createRowSourceEditor, createTextFileEditor } = await import(
	'./editor.svelte.ts'
);

const encoder = new TextEncoder();

// The real table's interpreter, so a fake entry reads exactly as a saved one.
const folder = expectOk(
	await openFolder({
		id: 'todos-editor-test',
		definition: todosDefinition,
		browser: {
			commitOnEdit: false,
			indexedDb: { indexedDB: new IDBFactory(), IDBKeyRange },
		},
	}),
);
afterAll(() => folder.close());
const { inspect } = folder.tables.todos;

async function entryFor(source: string): Promise<TableSnapshot<TodoFields>> {
	return {
		path: 'todos/milk.md',
		stem: 'milk',
		source,
		sha256: await hashBytes(encoder.encode(source)),
		...inspect(source),
	};
}

function recordingTable(release?: Promise<void>) {
	const writes: { baseline: string; source: string }[] = [];
	const table = {
		name: 'todos',
		async replace(baseline: SavedText, source: string) {
			writes.push({ baseline: baseline.source, source });
			await release;
			return { data: await entryFor(source), error: null };
		},
		async get() {
			return { data: undefined, error: null };
		},
	} as unknown as FileTable<TodoFields>;
	return { table, writes };
}

test('a row source editor saves text that does not parse, and its diagnostics describe the buffer', async () => {
	const { table, writes } = recordingTable();
	const original = '---\ntitle: Milk\ndone: false\n---\n';
	const editor = createRowSourceEditor(
		table,
		await entryFor(original),
		() => {},
	);
	const broken = '---\ntitle: *missing\ndone: soon\n---\nbody\n';

	editor.input(broken);
	// The draft is inspected as it is typed. A failed parse recovers no body.
	const draft = inspect(editor.buffer);
	expect(draft.body).toBeUndefined();
	expect(draft.parseError?.diagnostics[0].message).toContain(
		'Unresolved alias',
	);
	// The saved file still reads as it was saved: the two are different text.
	expect(inspect(editor.baseline.source).fields.title).toBe('Milk');

	// A field issue leaves the other fields readable, and is the buffer's own.
	editor.input(original.replace('done: false', 'done: soon'));
	expect(inspect(editor.buffer).fields).toEqual({ title: 'Milk' });
	expect(inspect(editor.buffer).issues.map((issue) => issue.field)).toEqual([
		'done',
	]);
	expect(inspect(editor.baseline.source).issues).toEqual([]);

	// Malformed text saves, and the saved capture is the next baseline.
	editor.input(broken);
	await editor.save();
	expect(writes).toEqual([{ baseline: original, source: broken }]);
	expect(editor.baseline.source).toBe(broken);
	expect(editor.saveState).toEqual({ kind: 'saved' });
	expect(editor.dirty).toBe(false);
	editor.dispose();
});

test('typing during a save stays dirty after the earlier generation is accepted', async () => {
	let release!: () => void;
	const { table, writes } = recordingTable(
		new Promise<void>((resolve) => {
			release = resolve;
		}),
	);
	const original = '---\ntitle: Milk\ndone: false\n---\n';
	const editor = createRowSourceEditor(
		table,
		await entryFor(original),
		() => {},
	);
	editor.input(`${original}A\n`);
	const saving = editor.save();
	editor.input(`${original}A and B\n`);
	release();
	await saving;
	expect(writes[0]?.source).toBe(`${original}A\n`);
	expect(editor.baseline.source).toBe(`${original}A\n`);
	expect(editor.buffer).toBe(`${original}A and B\n`);
	expect(editor.dirty).toBe(true);
	editor.dispose();
});

test('a same-byte observation becomes the baseline without replacing typing, and changed bytes do not', async () => {
	const { table, writes } = recordingTable();
	const original = await entryFor('---\ntitle: Milk\ndone: false\n---\n');
	const editor = createRowSourceEditor(table, original, () => {});
	const mine = `${original.source}mine\n`;
	editor.input(mine);

	// A later listing of the same bytes: a new observation of the same file.
	const again = await entryFor(original.source);
	editor.observe(again);
	expect(editor.baseline).toBe(again);
	expect(editor.buffer).toBe(mine);
	expect(editor.dirty).toBe(true);

	// Another writer's bytes are not adopted under unsaved typing, so the next
	// save is still checked against the version the typing started from.
	editor.observe(await entryFor(`${original.source}theirs\n`));
	expect(editor.baseline).toBe(again);
	expect(editor.buffer).toBe(mine);

	// An observation of another path is not this draft's file.
	editor.observe({ ...again, path: 'todos/oat.md' });
	expect(editor.baseline).toBe(again);

	await editor.save();
	expect(writes).toEqual([{ baseline: original.source, source: mine }]);
	editor.dispose();
});

// ============================================================================
// Moves
// ============================================================================

test('a move drains the admitted save, holds later saves, and resumes them at the adopted path', async () => {
	const { table, writes } = recordingTable();
	const original = await entryFor('---\ntitle: Milk\ndone: false\n---\n');
	const editor = createRowSourceEditor(table, original, () => {});
	const first = `${original.source}first\n`;
	const second = `${original.source}second\n`;
	const run: { settled?: SavedText; answer?: () => void } = {};

	editor.input(first);
	const moving = editor.move(async (settled) => {
		run.settled = settled;
		await new Promise<void>((resolve) => {
			run.answer = resolve;
		});
		return Ok({ ...settled, path: 'todos/oat.md' });
	});
	while (run.answer === undefined) await Bun.sleep(1);
	// The move ran against the file the drained save was accepted as.
	expect(run.settled?.source).toBe(first);
	expect(writes).toEqual([{ baseline: original.source, source: first }]);

	editor.input(second);
	await editor.save();
	await editor.retry();
	expect(await editor.move(async (settled) => Ok(settled))).toBeUndefined();
	let settled = false;
	const settling = editor.settle().then((idle) => {
		settled = idle;
	});
	// Longer than the typing batch: the autosave timer is held too.
	await Bun.sleep(450);
	expect(writes).toHaveLength(1);
	expect(settled).toBe(false);
	expect(editor.path).toBe('todos/milk.md');

	run.answer();
	expect((await moving)?.data?.path).toBe('todos/oat.md');
	expect(editor.path).toBe('todos/oat.md');
	expect(editor.buffer).toBe(second);
	await settling;
	expect(settled).toBe(true);
	expect(writes[1]).toEqual({ baseline: first, source: second });
	editor.dispose();
});

test('a move does not run while the input cannot be saved, and a failed move adopts nothing', async () => {
	const original = await entryFor('---\ntitle: Milk\ndone: false\n---\n');
	const { table } = conflictingTable(
		await entryFor('elsewhere'),
		Ok(undefined),
	);
	const editor = createRowSourceEditor(table, original, () => {});
	let runs = 0;
	const run = async () => {
		runs++;
		return Err('The destination is taken.');
	};

	editor.input(`${original.source}mine\n`);
	expect(await editor.move(run)).toBeUndefined();
	expect(runs).toBe(0);
	expect(editor.saveState.kind).toBe('conflict');

	const clean = createRowSourceEditor(table, original, () => {});
	expect((await clean.move(run))?.error).toBe('The destination is taken.');
	expect(runs).toBe(1);
	expect(clean.baseline).toBe(original);
	expect(clean.saveState).toEqual({ kind: 'saved' });
	editor.dispose();
	clean.dispose();
});

// ============================================================================
// Conflict review reads
// ============================================================================

type TodoRead = Awaited<ReturnType<FileTable<TodoFields>['get']>>;

/**
 * A table holding `theirs`: a write checked against any other sha256
 * conflicts, and the fresh read for review answers whatever `saved` is now.
 */
function conflictingTable(theirs: TableSnapshot<TodoFields>, saved: TodoRead) {
	const writes: { baseline: string; source: string }[] = [];
	const state = { saved };
	const table = {
		name: 'todos',
		async replace(baseline: SavedText, source: string) {
			writes.push({ baseline: baseline.source, source });
			return baseline.sha256 === theirs.sha256
				? Ok(await entryFor(source))
				: FileError.Conflict({
						path: baseline.path,
						expectedSha256: baseline.sha256,
						actualSha256: theirs.sha256,
					});
		},
		get: async () => state.saved,
	} as unknown as FileTable<TodoFields>;
	return { table, writes, state };
}

test('a conflict whose saved row cannot be read fails the save, and a retry repeats it', async () => {
	const original = await entryFor('---\ntitle: Milk\ndone: false\n---\n');
	const theirs = await entryFor(`${original.source}theirs\n`);
	const mine = `${original.source}mine\n`;
	const attempt = { baseline: original.source, source: mine };
	const { table, writes, state } = conflictingTable(
		theirs,
		FileError.Io({
			path: original.path,
			operation: 'read',
			cause: new Error('disk unplugged'),
		}),
	);
	const editor = createRowSourceEditor(table, original, () => {});

	editor.input(mine);
	await editor.save();
	expect(editor.saveState).toEqual({
		kind: 'failed',
		message: expect.stringContaining('disk unplugged'),
	});
	// Nothing was reviewed, so neither conflict choice can act.
	editor.loadSaved();
	await editor.keepMine();
	expect(editor.baseline).toBe(original);
	expect(editor.buffer).toBe(mine);
	expect(writes).toEqual([attempt]);

	state.saved = TableError.InvalidUtf8({ path: original.path });
	await editor.retry();
	expect(editor.saveState).toEqual({
		kind: 'failed',
		message: expect.stringContaining('not valid UTF-8'),
	});
	expect(editor.baseline).toBe(original);
	expect(editor.buffer).toBe(mine);
	expect(writes).toEqual([attempt, attempt]);

	state.saved = Ok(theirs);
	await editor.retry();
	expect(editor.saveState).toMatchObject({ kind: 'conflict', current: theirs });
	expect(editor.baseline).toBe(original);
	expect(writes).toEqual([attempt, attempt, attempt]);

	await editor.keepMine();
	expect(writes[3]).toEqual({ baseline: theirs.source, source: mine });
	expect(editor.saveState.kind).toBe('saved');
	expect(editor.dirty).toBe(false);
	editor.dispose();
});

test('a conflicting row source reads as removed only when its file is absent', async () => {
	const original = await entryFor('---\ntitle: Milk\ndone: false\n---\n');
	const { table, state } = conflictingTable(
		await entryFor('elsewhere'),
		FileError.Closed(),
	);
	const editor = createRowSourceEditor(table, original, () => {});

	editor.input(`${original.source}mine\n`);
	await editor.save();
	expect(editor.saveState).toEqual({
		kind: 'failed',
		message: expect.stringContaining('The folder is closed'),
	});

	state.saved = Ok(undefined);
	await editor.retry();
	expect(editor.saveState).toMatchObject({
		kind: 'conflict',
		current: undefined,
	});
	expect(editor.buffer).toBe(`${original.source}mine\n`);
	editor.dispose();
});

// ============================================================================
// Raw text saves
// ============================================================================

test('a raw save replaces the captured baseline and adopts the capture the folder returns, reading nothing back', async () => {
	const replaces: { file: FileCapture; content: Uint8Array }[] = [];
	const files = {
		async replace(file: FileCapture, content: Uint8Array) {
			replaces.push({ file, content });
			return Ok({ path: file.path, sha256: await hashBytes(content) });
		},
		async read(): Promise<never> {
			throw new Error('a successful save reads nothing back');
		},
	} as unknown as FolderFiles;
	const file = {
		path: 'notes.txt',
		source: 'saved',
		sha256: await hashBytes(encoder.encode('saved')),
	};
	const editor = createTextFileEditor(files, file, () => {});

	editor.input('first');
	await editor.save();
	expect(replaces).toEqual([{ file, content: encoder.encode('first') }]);
	const first = await hashBytes(encoder.encode('first'));
	expect(editor.baseline).toEqual({
		path: 'notes.txt',
		source: 'first',
		sha256: first,
	});
	expect(editor.saveState).toEqual({ kind: 'saved' });
	expect(editor.dirty).toBe(false);

	// The next save is checked against the capture the first one returned.
	editor.input('second');
	await editor.save();
	expect(replaces[1]?.file).toMatchObject({
		path: 'notes.txt',
		sha256: first,
	});
	expect(replaces[1]?.content).toEqual(encoder.encode('second'));
	editor.dispose();
});

for (const kind of ['row source', 'raw file'] as const)
	test(`a ${kind} saved with an unpaired surrogate settles on the text of the bytes sent and is not sent again`, async () => {
		const path = kind === 'row source' ? 'todos/lone.md' : 'lone.txt';
		const original = '---\ntitle: Milk\ndone: false\n---\n';
		const created = expectOk(await folder.files.create(path, original));
		let saves = 0;
		const onSaved = () => {
			saves += 1;
		};
		const editor =
			kind === 'row source'
				? createRowSourceEditor(
						folder.tables.todos,
						expectOk(await folder.tables.todos.get('lone'))!,
						onSaved,
					)
				: createTextFileEditor(
						folder.files,
						{ ...created, source: original },
						onSaved,
					);

		// A byte order mark, CRLF, and a surrogate pair are saved as typed. The
		// unpaired surrogate cannot be: its bytes are the replacement character's.
		const typed = `﻿${original}lone \uD800 pair \u{1F600}\r\n`;
		const stored = typed.replace('\uD800', '�');
		editor.input(typed);
		await editor.save();
		const bytes = expectOk(await folder.files.read(path)).bytes;
		expect(bytes).toEqual(encoder.encode(stored));
		expect(editor.baseline.source).toBe(stored);
		expect(editor.baseline.sha256).toBe(await hashBytes(bytes));
		expect(editor.buffer).toBe(stored);
		expect(editor.dirty).toBe(false);
		expect(await editor.settle()).toBe(true);
		expect(saves).toBe(1);

		// The capture is the file's, so the next save is accepted against it.
		editor.input(`${stored}more\n`);
		await editor.save();
		expect(editor.saveState).toEqual({ kind: 'saved' });
		expect(saves).toBe(2);
		editor.dispose();
		expectOk(await folder.files.remove(editor.baseline));
	});

test('typing during a save whose text encoding changed stays as typed, and settles on its own save', async () => {
	let release!: () => void;
	const { table, writes } = recordingTable(
		new Promise<void>((resolve) => {
			release = resolve;
		}),
	);
	const original = '---\ntitle: Milk\ndone: false\n---\n';
	const editor = createRowSourceEditor(
		table,
		await entryFor(original),
		() => {},
	);
	editor.input(`${original}a\uD800`);
	const saving = editor.save();
	editor.input(`${original}a\uD800b`);
	release();
	await saving;
	expect(editor.baseline.source).toBe(`${original}a�`);
	// The newer generation is not the text that was sent: it is left alone.
	expect(editor.buffer).toBe(`${original}a\uD800b`);
	expect(editor.dirty).toBe(true);

	await editor.save();
	expect(writes.map((write) => write.source)).toEqual([
		`${original}a�`,
		`${original}a�b`,
	]);
	expect(editor.buffer).toBe(`${original}a�b`);
	expect(editor.dirty).toBe(false);
	editor.dispose();
});

/** Raw files whose replace always conflicts and whose read answers `saved`. */
function conflictingFiles(saved: Result<CapturedFile, FileError>) {
	const writes: unknown[] = [];
	const state = { saved };
	const files = {
		async replace(file: FileCapture, content: Uint8Array) {
			writes.push({ path: file.path, sha256: file.sha256, content });
			return FileError.Conflict({
				path: file.path,
				expectedSha256: file.sha256,
				actualSha256: undefined,
			});
		},
		read: async () => state.saved,
	} as unknown as FolderFiles;
	return { files, writes, state };
}

async function fileRead(
	bytes: Uint8Array,
): Promise<Result<CapturedFile, FileError>> {
	return Ok({ path: 'notes.txt', bytes, sha256: await hashBytes(bytes) });
}

const unreadable: [
	string,
	() => Promise<Result<CapturedFile, FileError>>,
	string,
][] = [
	[
		'an I/O failure',
		async () =>
			FileError.Io({
				path: 'notes.txt',
				operation: 'read',
				cause: new Error('disk unplugged'),
			}),
		'disk unplugged',
	],
	['a closed folder', async () => FileError.Closed(), 'The folder is closed'],
	['invalid UTF-8', () => fileRead(new Uint8Array([0xff, 0xfe])), 'not text'],
	['NUL bytes', () => fileRead(new Uint8Array([104, 0, 105])), 'not text'],
	[
		'text over the editable limit',
		() => fileRead(new Uint8Array(EDITABLE_TEXT_LIMIT + 1).fill(97)),
		'larger than 1 MB',
	],
];

for (const [name, saved, message] of unreadable)
	test(`a raw conflict review that reads ${name} fails the save and keeps the draft`, async () => {
		const original = encoder.encode('saved');
		const sha256 = await hashBytes(original);
		const file = { path: 'notes.txt', source: 'saved', sha256 };
		const { files, writes } = conflictingFiles(await saved());
		const editor = createTextFileEditor(files, file, () => {});
		const attempt = {
			path: 'notes.txt',
			sha256,
			content: encoder.encode('mine'),
		};

		editor.input('mine');
		await editor.save();
		expect(editor.saveState).toEqual({
			kind: 'failed',
			message: expect.stringContaining(message),
		});
		editor.loadSaved();
		await editor.keepMine();
		expect(editor.baseline).toBe(file);
		expect(editor.buffer).toBe('mine');
		expect(writes).toEqual([attempt]);

		await editor.retry();
		expect(editor.saveState.kind).toBe('failed');
		expect(editor.baseline).toBe(file);
		expect(writes).toEqual([attempt, attempt]);
		editor.dispose();
	});

/**
 * One saved file behind both draft kinds, counting every write it is sent.
 * `next` answers the next write: `land` publishes it, `lost` publishes it and
 * loses the reply, and `fail` publishes nothing. A write whose baseline is no
 * longer the stored text conflicts, as a conditional save does.
 */
async function countingStore(kind: 'raw file' | 'row source') {
	const path = kind === 'raw file' ? 'notes.txt' : 'todos/milk.md';
	const store = {
		stored: 'saved',
		writes: [] as string[],
		next: 'land' as 'land' | 'lost' | 'fail',
	};
	const capture = async (source: string) => ({
		path,
		source,
		sha256: await hashBytes(encoder.encode(source)),
	});
	async function write(baseline: SavedText, source: string) {
		store.writes.push(source);
		const current = await capture(store.stored);
		if (baseline.sha256 !== current.sha256)
			return FileError.Conflict({
				path,
				expectedSha256: baseline.sha256,
				actualSha256: current.sha256,
			});
		const outcome = store.next;
		store.next = 'land';
		if (outcome === 'fail')
			return FileError.Io({
				path,
				operation: 'write',
				cause: new Error('disk full'),
			});
		store.stored = source;
		if (outcome === 'lost')
			return FileError.Unconfirmed({
				path,
				operation: 'write',
				cause: new Error('the reply was lost'),
			});
		return Ok(await capture(source));
	}
	const original = await capture('saved');
	const editor =
		kind === 'raw file'
			? createTextFileEditor(
					{
						// A raw save checks only the capture's hash.
						replace: (file: FileCapture, content: Uint8Array) =>
							write({ ...file, source: '' }, new TextDecoder().decode(content)),
						read: async () => fileRead(encoder.encode(store.stored)),
					} as unknown as FolderFiles,
					original,
					() => {},
				)
			: createRowSourceEditor(
					{
						name: 'todos',
						replace: write,
						get: async () =>
							Ok({ ...(await capture(store.stored)), stem: 'milk' }),
					} as unknown as FileTable<TodoFields>,
					original,
					() => {},
				);
	return { store, editor, original, capture };
}

for (const kind of ['raw file', 'row source'] as const) {
	test(`a ${kind} save whose reply was lost sends nothing more on its own, and a matching read does not make it saved`, async () => {
		const { store, editor, original, capture } = await countingStore(kind);

		store.next = 'lost';
		editor.input('mine');
		await editor.save();
		expect(editor.saveState).toEqual({ kind: 'unknown', operation: 'save' });
		expect(editor.hasProblem).toBe(true);
		expect(editor.isDiscardable).toBe(true);
		expect(store.writes).toEqual(['mine']);
		// The file now holds the sent bytes. Reading them is not a receipt.
		editor.observe(await capture('mine'));
		expect(editor.saveState).toEqual({ kind: 'unknown', operation: 'save' });
		expect(editor.baseline).toEqual(original);

		// Newer input stays on screen; no timer, save, settle, or move sends it.
		editor.input('mine and more');
		await Bun.sleep(450);
		await editor.save();
		expect(await editor.settle()).toBe(false);
		let moves = 0;
		expect(
			await editor.move(async (settled) => {
				moves++;
				return Ok(settled);
			}),
		).toBeUndefined();
		expect(moves).toBe(0);
		expect(editor.buffer).toBe('mine and more');
		expect(store.writes).toEqual(['mine']);

		// Trying again makes one new conditional attempt. The bytes that did
		// land are no longer the baseline, so they come back for review.
		await editor.retry();
		expect(store.writes).toEqual(['mine', 'mine and more']);
		expect(editor.saveState).toMatchObject({
			kind: 'conflict',
			current: { source: 'mine' },
		});
		expect(editor.buffer).toBe('mine and more');
		await editor.keepMine();
		expect(store.writes).toEqual(['mine', 'mine and more', 'mine and more']);
		expect(store.stored).toBe('mine and more');
		expect(editor.saveState).toEqual({ kind: 'saved' });
		editor.dispose();
	});

	test(`a ${kind} whose delete reply was lost sends nothing more on its own, and only trying again checks the file`, async () => {
		const { store, editor } = await countingStore(kind);

		// Typing arrives before the delete's reply, which is lost.
		const removed = await editor.remove(async () => {
			editor.input('typed during');
			return FileError.Unconfirmed({
				path: editor.path,
				operation: 'remove',
				cause: new Error('the reply was lost'),
			});
		});
		expect(removed?.error?.name).toBe('Unconfirmed');
		expect(editor.saveState).toEqual({ kind: 'unknown', operation: 'delete' });
		expect(editor.isDiscardable).toBe(true);
		await Bun.sleep(450);
		await editor.save();
		expect(await editor.settle()).toBe(false);
		expect(store.writes).toEqual([]);
		expect(editor.buffer).toBe('typed during');

		// The person's attempt is one conditional save. This delete never
		// landed, so the file is the baseline and the save is accepted.
		await editor.retry();
		expect(store.writes).toEqual(['typed during']);
		expect(editor.saveState).toEqual({ kind: 'saved' });
		editor.dispose();
	});

	test(`a failed ${kind} save sends nothing more on its own, and trying again makes one attempt`, async () => {
		const { store, editor } = await countingStore(kind);

		store.next = 'fail';
		editor.input('mine');
		await editor.save();
		expect(editor.saveState).toEqual({
			kind: 'failed',
			message: expect.stringContaining('disk full'),
		});
		editor.input('mine and more');
		await Bun.sleep(450);
		await editor.save();
		expect(await editor.settle()).toBe(false);
		expect(store.writes).toEqual(['mine']);
		expect(store.stored).toBe('saved');

		await editor.retry();
		expect(store.writes).toEqual(['mine', 'mine and more']);
		expect(store.stored).toBe('mine and more');
		expect(editor.saveState).toEqual({ kind: 'saved' });
		expect(editor.dirty).toBe(false);
		editor.dispose();
	});
}

test('a raw conflict reads as removed only when the file is absent', async () => {
	const sha256 = await hashBytes(encoder.encode('saved'));
	const { files } = conflictingFiles(FileError.NotFound({ path: 'notes.txt' }));
	const editor = createTextFileEditor(
		files,
		{ path: 'notes.txt', source: 'saved', sha256 },
		() => {},
	);

	editor.input('mine');
	await editor.save();
	expect(editor.saveState).toMatchObject({
		kind: 'conflict',
		current: undefined,
	});
	expect(editor.buffer).toBe('mine');
	editor.dispose();
});

test('a retry after a failed raw review reaches the saved file for the conflict choice', async () => {
	const sha256 = await hashBytes(encoder.encode('saved'));
	const { files, state } = conflictingFiles(FileError.Closed());
	const editor = createTextFileEditor(
		files,
		{ path: 'notes.txt', source: 'saved', sha256 },
		() => {},
	);

	editor.input('mine');
	await editor.save();
	expect(editor.saveState.kind).toBe('failed');

	const theirs = encoder.encode('theirs');
	state.saved = await fileRead(theirs);
	await editor.retry();
	expect(editor.saveState).toMatchObject({
		kind: 'conflict',
		current: { path: 'notes.txt', source: 'theirs' },
	});
	expect(editor.buffer).toBe('mine');

	editor.loadSaved();
	expect(editor.buffer).toBe('theirs');
	expect(editor.baseline.sha256 === (await hashBytes(theirs))).toBe(true);
	expect(editor.saveState.kind).toBe('saved');
	editor.dispose();
});
