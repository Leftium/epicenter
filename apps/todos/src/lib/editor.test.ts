/**
 * Raw Text Editor Tests
 *
 * Drives the real raw draft runes module (compiled with Svelte's module
 * compiler): the plain editor for any text file that is not a todo row. It
 * keeps the buffer and the accepted baseline separate, saves conditionally,
 * and never crashes on content it cannot interpret. Todo rows, including
 * their source, are edited through the native row editor instead; see
 * `todo-editor.test.ts`.
 *
 * Key behaviors:
 * - Saving writes the exact buffer against the captured baseline
 * - Typing during a save stays dirty after the save is accepted
 * - A same-byte observation becomes the baseline without replacing typing
 * - A move drains the admitted save, holds later saves, and resumes them at
 *   the adopted path; a failed move adopts nothing
 * - A raw save replaces the baseline's capture, and the capture the folder
 *   returns is the next baseline, with nothing read back
 * - An accepted save's baseline is the text of the bytes sent; a buffer still
 *   at that generation becomes it, so an unpaired surrogate settles and is
 *   not sent again, while newer typing stays as typed
 * - A conflict reads as removed only when the saved file is absent; a saved
 *   file that cannot be read fails the save, keeps the baseline and the
 *   buffer, and a retry repeats the same conditional save
 * - A save whose store threw, published or not, is unknown with the throw's
 *   cause; a storage refusal such as `Io` stays a failed save
 * - A failed save, or one whose reply was lost, sends nothing more on its
 *   own: newer input stays on screen, and no timer, settle, or move resends
 *   it. Trying again makes one conditional attempt; bytes an unknown save did
 *   land come back as a conflict, and a read of them is never a receipt
 *
 * See also:
 * - `todo-editor.test.ts` for the todo editor over a native row editor
 * - `todos.test.ts` for raw text drafts against a real browser folder
 */
import './svelte-modules.test-support.js';
import { afterAll, expect, test } from 'bun:test';
import type {
	CapturedFile,
	FileCapture,
	FolderFiles,
} from '@epicenter/folder';
import { FileError, hashBytes } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { testBrowserStorage } from '../../../../packages/folder/src/browser-storage.test-support.js';
import { todosDefinition } from './definition.js';
import type { SavedText } from './editor.svelte.js';
import { EDITABLE_TEXT_LIMIT } from './files.js';

const { createTextFileEditor } = await import('./editor.svelte.ts');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// A real folder, for the tests that save through one.
const folder = expectOk(
	await openFolder({
		id: 'todos-editor-test',
		definition: todosDefinition,
		browser: { commitOnEdit: false, ...testBrowserStorage() },
	}),
);
afterAll(() => folder.close());

/** Every text a test captured, by hash: a raw save names its baseline only by hash. */
const hashed = new Map<string, string>();

async function capture(text: string, path = 'notes.txt'): Promise<SavedText> {
	const sha256 = await hashBytes(encoder.encode(text));
	hashed.set(sha256, text);
	return { path, text, sha256 };
}

/** Raw files that accept every replace, recording each with the baseline text it was checked against. */
function recordingFiles(release?: Promise<void>) {
	const writes: { path: string; baseline: string | undefined; source: string }[] =
		[];
	const files = {
		async replace(file: FileCapture, content: Uint8Array) {
			writes.push({
				path: file.path,
				baseline: hashed.get(file.sha256),
				source: decoder.decode(content),
			});
			await release;
			return Ok({ path: file.path, sha256: await hashBytes(content) });
		},
	} as unknown as FolderFiles;
	return { files, writes };
}

async function fileRead(
	bytes: Uint8Array,
): Promise<Result<CapturedFile, FileError>> {
	return Ok({ path: 'notes.txt', bytes, sha256: await hashBytes(bytes) });
}

/**
 * Raw files holding `theirs`: a replace checked against any other sha256
 * conflicts, and the fresh read for review answers whatever `saved` is now.
 */
function conditionalFiles(
	theirs: SavedText,
	saved: Result<CapturedFile, FileError>,
) {
	const writes: { baseline: string | undefined; source: string }[] = [];
	const state = { saved };
	const files = {
		async replace(file: FileCapture, content: Uint8Array) {
			writes.push({
				baseline: hashed.get(file.sha256),
				source: decoder.decode(content),
			});
			return file.sha256 === theirs.sha256
				? Ok({ path: file.path, sha256: await hashBytes(content) })
				: FileError.Conflict({
						path: file.path,
						expectedSha256: file.sha256,
						actualSha256: theirs.sha256,
					});
		},
		read: async () => state.saved,
	} as unknown as FolderFiles;
	return { files, writes, state };
}

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

test('typing during a save stays dirty after the earlier generation is accepted', async () => {
	let release!: () => void;
	const { files, writes } = recordingFiles(
		new Promise<void>((resolve) => {
			release = resolve;
		}),
	);
	const editor = createTextFileEditor(files, await capture('saved'), () => {});
	editor.input('A\n');
	const saving = editor.save();
	editor.input('A and B\n');
	release();
	await saving;
	expect(writes[0]?.source).toBe('A\n');
	expect(editor.baseline.text).toBe('A\n');
	expect(editor.buffer).toBe('A and B\n');
	expect(editor.dirty).toBe(true);
	editor.dispose();
});

test('a same-byte observation becomes the baseline without replacing typing, and changed bytes do not', async () => {
	const { files, writes } = recordingFiles();
	const original = await capture('saved\n');
	const editor = createTextFileEditor(files, original, () => {});
	const mine = 'saved\nmine\n';
	editor.input(mine);

	// A later listing of the same bytes: a new observation of the same file.
	const again = await capture(original.text);
	editor.observe(again);
	expect(editor.baseline).toBe(again);
	expect(editor.buffer).toBe(mine);
	expect(editor.dirty).toBe(true);

	// Another writer's bytes are not adopted under unsaved typing, so the next
	// save is still checked against the version the typing started from.
	editor.observe(await capture('saved\ntheirs\n'));
	expect(editor.baseline).toBe(again);
	expect(editor.buffer).toBe(mine);

	// An observation of another path is not this draft's file.
	editor.observe({ ...again, path: 'other.txt' });
	expect(editor.baseline).toBe(again);

	await editor.save();
	expect(writes).toEqual([
		{ path: 'notes.txt', baseline: original.text, source: mine },
	]);
	editor.dispose();
});

// ============================================================================
// Moves
// ============================================================================

test('a move drains the admitted save, holds later saves, and resumes them at the adopted path', async () => {
	const { files, writes } = recordingFiles();
	const original = await capture('saved\n');
	const editor = createTextFileEditor(files, original, () => {});
	const first = 'saved\nfirst\n';
	const second = 'saved\nsecond\n';
	const run: { settled?: SavedText; answer?: () => void } = {};

	editor.input(first);
	const moving = editor.move(async (settled) => {
		run.settled = settled;
		await new Promise<void>((resolve) => {
			run.answer = resolve;
		});
		return Ok({ ...settled, path: 'oat.txt' });
	});
	while (run.answer === undefined) await Bun.sleep(1);
	// The move ran against the file the drained save was accepted as.
	expect(run.settled?.text).toBe(first);
	expect(writes).toEqual([
		{ path: 'notes.txt', baseline: original.text, source: first },
	]);

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
	expect(editor.path).toBe('notes.txt');

	run.answer();
	expect((await moving)?.data?.path).toBe('oat.txt');
	expect(editor.path).toBe('oat.txt');
	expect(editor.buffer).toBe(second);
	await settling;
	expect(settled).toBe(true);
	// The resumed save addresses the file at the adopted path.
	expect(writes[1]).toMatchObject({ path: 'oat.txt', source: second });
	editor.dispose();
});

test('a move does not run while the input cannot be saved, and a failed move adopts nothing', async () => {
	const original = await capture('saved');
	const { files } = conflictingFiles(await fileRead(encoder.encode('elsewhere')));
	const editor = createTextFileEditor(files, original, () => {});
	let runs = 0;
	const run = async () => {
		runs++;
		return Err('The destination is taken.');
	};

	editor.input('mine');
	expect(await editor.move(run)).toBeUndefined();
	expect(runs).toBe(0);
	expect(editor.saveState.kind).toBe('conflict');

	const clean = createTextFileEditor(files, original, () => {});
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

test('a conflict whose saved file cannot be read fails the save, and a retry repeats it', async () => {
	const original = await capture('saved\n');
	const theirs = await capture('saved\ntheirs\n');
	const mine = 'saved\nmine\n';
	const attempt = { baseline: original.text, source: mine };
	const { files, writes, state } = conditionalFiles(
		theirs,
		FileError.Io({
			path: original.path,
			operation: 'read',
			cause: new Error('disk unplugged'),
		}),
	);
	const editor = createTextFileEditor(files, original, () => {});

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

	state.saved = await fileRead(new Uint8Array([0xff, 0xfe]));
	await editor.retry();
	expect(editor.saveState).toEqual({
		kind: 'failed',
		message: expect.stringContaining('not text'),
	});
	expect(editor.baseline).toBe(original);
	expect(editor.buffer).toBe(mine);
	expect(writes).toEqual([attempt, attempt]);

	state.saved = await fileRead(encoder.encode(theirs.text));
	await editor.retry();
	expect(editor.saveState).toMatchObject({
		kind: 'conflict',
		current: { text: theirs.text, sha256: theirs.sha256 },
	});
	expect(editor.baseline).toBe(original);
	expect(writes).toEqual([attempt, attempt, attempt]);

	await editor.keepMine();
	expect(writes[3]).toEqual({ baseline: theirs.text, source: mine });
	expect(editor.saveState.kind).toBe('saved');
	expect(editor.dirty).toBe(false);
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
		text: 'saved',
		sha256: await hashBytes(encoder.encode('saved')),
	};
	const editor = createTextFileEditor(files, file, () => {});

	editor.input('first');
	await editor.save();
	expect(replaces).toEqual([{ file, content: encoder.encode('first') }]);
	const first = await hashBytes(encoder.encode('first'));
	expect(editor.baseline).toEqual({
		path: 'notes.txt',
		text: 'first',
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

test('a raw file saved with an unpaired surrogate settles on the text of the bytes sent and is not sent again', async () => {
	const path = 'lone.txt';
	const original = '---\ntitle: Milk\ndone: false\n---\n';
	const created = expectOk(await folder.files.create(path, original));
	let saves = 0;
	const editor = createTextFileEditor(
		folder.files,
		{ ...created, text: original },
		() => {
			saves += 1;
		},
	);

	// A byte order mark, CRLF, and a surrogate pair are saved as typed. The
	// unpaired surrogate cannot be: its bytes are the replacement character's.
	const typed = `﻿${original}lone \uD800 pair \u{1F600}\r\n`;
	const stored = typed.replace('\uD800', '�');
	editor.input(typed);
	await editor.save();
	const bytes = expectOk(await folder.files.read(path)).bytes;
	expect(bytes).toEqual(encoder.encode(stored));
	expect(editor.baseline.text).toBe(stored);
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
	const { files, writes } = recordingFiles(
		new Promise<void>((resolve) => {
			release = resolve;
		}),
	);
	const editor = createTextFileEditor(files, await capture('saved'), () => {});
	editor.input('a\uD800');
	const saving = editor.save();
	editor.input('a\uD800b');
	release();
	await saving;
	expect(editor.baseline.text).toBe('a�');
	// The newer generation is not the text that was sent: it is left alone.
	expect(editor.buffer).toBe('a\uD800b');
	expect(editor.dirty).toBe(true);

	await editor.save();
	expect(writes.map((write) => write.source)).toEqual(['a�', 'a�b']);
	expect(editor.buffer).toBe('a�b');
	expect(editor.dirty).toBe(false);
	editor.dispose();
});

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
		const file = { path: 'notes.txt', text: 'saved', sha256 };
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
 * One saved file behind a raw draft, counting every write it is sent.
 * `next` answers the next write: `land` publishes it, `lost` publishes it and
 * loses the reply, `thrown` publishes it and then throws instead of
 * answering, and `fail` publishes nothing. A write whose baseline is no
 * longer the stored text conflicts, as a conditional save does.
 */
async function countingStore() {
	const path = 'notes.txt';
	const store = {
		stored: 'saved',
		writes: [] as string[],
		next: 'land' as 'land' | 'lost' | 'thrown' | 'fail',
	};
	const captureOf = async (source: string) => ({
		path,
		text: source,
		sha256: await hashBytes(encoder.encode(source)),
	});
	async function write(file: FileCapture, content: Uint8Array) {
		const source = decoder.decode(content);
		store.writes.push(source);
		const current = await captureOf(store.stored);
		if (file.sha256 !== current.sha256)
			return FileError.Conflict({
				path,
				expectedSha256: file.sha256,
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
		if (outcome === 'thrown') throw new Error('connection reset');
		if (outcome === 'lost')
			return FileError.Unconfirmed({
				path,
				operation: 'write',
				cause: new Error('the reply was lost'),
			});
		const { sha256 } = await captureOf(source);
		return Ok({ path, sha256 });
	}
	const original = await captureOf('saved');
	const editor = createTextFileEditor(
		{
			// A raw save checks only the capture's hash.
			replace: write,
			read: async () => fileRead(encoder.encode(store.stored)),
		} as unknown as FolderFiles,
		original,
		() => {},
	);
	return { store, editor, original, capture: captureOf };
}

test("a raw save that published and then threw is unknown with its cause, a matching read does not make it saved, and the person's retry is still checked", async () => {
	const { store, editor, original, capture: captureOf } = await countingStore();
	const unknown = {
		kind: 'unknown',
		operation: 'save',
		message: 'connection reset',
	} as const;

	store.next = 'thrown';
	editor.input('mine');
	await editor.save();
	expect(editor.saveState).toEqual(unknown);
	expect(editor.hasProblem).toBe(true);
	expect(editor.isDiscardable).toBe(true);
	expect(store.stored).toBe('mine');
	editor.observe(await captureOf('mine'));
	expect(editor.saveState).toEqual(unknown);
	expect(editor.baseline).toEqual(original);

	editor.input('mine and more');
	await Bun.sleep(450);
	await editor.save();
	expect(await editor.settle()).toBe(false);
	expect(store.writes).toEqual(['mine']);

	// The landed bytes are not the baseline, so the retry brings them back
	// for review instead of overwriting them.
	await editor.retry();
	expect(store.writes).toEqual(['mine', 'mine and more']);
	expect(editor.saveState).toMatchObject({
		kind: 'conflict',
		current: { text: 'mine' },
	});
	await editor.keepMine();
	expect(store.stored).toBe('mine and more');
	expect(editor.saveState).toEqual({ kind: 'saved' });
	editor.dispose();
});

test('a raw save that storage refused as Io stays a failed save', async () => {
	const { store, editor } = await countingStore();
	store.next = 'fail';
	editor.input('mine');
	await editor.save();
	expect(editor.saveState.kind).toBe('failed');
	expect(store.stored).toBe('saved');
	editor.dispose();
});

test('a raw save whose reply was lost sends nothing more on its own, and a matching read does not make it saved', async () => {
	const { store, editor, original, capture: captureOf } = await countingStore();

	store.next = 'lost';
	editor.input('mine');
	await editor.save();
	expect(editor.saveState).toEqual({ kind: 'unknown', operation: 'save' });
	expect(editor.hasProblem).toBe(true);
	expect(editor.isDiscardable).toBe(true);
	expect(store.writes).toEqual(['mine']);
	// The file now holds the sent bytes. Reading them is not a receipt.
	editor.observe(await captureOf('mine'));
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
		current: { text: 'mine' },
	});
	expect(editor.buffer).toBe('mine and more');
	await editor.keepMine();
	expect(store.writes).toEqual(['mine', 'mine and more', 'mine and more']);
	expect(store.stored).toBe('mine and more');
	expect(editor.saveState).toEqual({ kind: 'saved' });
	editor.dispose();
});

test('a raw file whose delete reply was lost sends nothing more on its own, and only trying again checks the file', async () => {
	const { store, editor } = await countingStore();

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

test('a failed raw save sends nothing more on its own, and trying again makes one attempt', async () => {
	const { store, editor } = await countingStore();

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

test('a raw conflict reads as removed only when the file is absent', async () => {
	const sha256 = await hashBytes(encoder.encode('saved'));
	const { files } = conflictingFiles(FileError.NotFound({ path: 'notes.txt' }));
	const editor = createTextFileEditor(
		files,
		{ path: 'notes.txt', text: 'saved', sha256 },
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
		{ path: 'notes.txt', text: 'saved', sha256 },
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
		current: { path: 'notes.txt', text: 'theirs' },
	});
	expect(editor.buffer).toBe('mine');

	editor.loadSaved();
	expect(editor.buffer).toBe('theirs');
	expect(editor.baseline.sha256 === (await hashBytes(theirs))).toBe(true);
	expect(editor.saveState.kind).toBe('saved');
	editor.dispose();
});
