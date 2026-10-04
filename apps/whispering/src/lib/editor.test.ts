/**
 * Text Draft Tests
 *
 * The app's draft of an ordinary file, also used for a row file edited as its
 * text, over a real folder's own `files`. Replies are decided per save by
 * wrapping those files: a write that lands and whose reply is lost, a
 * refusal, a throw, or a reply held open.
 *
 * Key behaviors:
 * - only a save's own receipt advances the baseline; an accepted save's
 *   baseline is the text of the bytes sent, so an unpaired surrogate settles
 *   and newer typing stays as typed
 * - a save that was refused, threw, or lost its reply stops saving: later
 *   typing, a pause, settling, a reread, and disposal write nothing more
 * - a file found holding the draft's text is current content, not the
 *   outcome of the lost save: it is shown for review and stays unknown, and
 *   taking it acknowledges the file without calling the save confirmed
 * - trying again is one conditional save against the baseline the draft was
 *   made on; a file changed since, by the lost save included, is reviewed
 * - conflict reads distinguish a missing file from an unreadable one
 *
 * See also:
 * - `row-draft.test.ts` for rows, which the folder's row editor holds
 * - `workspace/desktop.test.ts` for a row save whose reply the shell lost
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileError, type FolderFiles } from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';
import { readTextFile } from './files.js';
import { openTestFolder } from './workspace.test-support.js';

const { createTextFileEditor, TYPING_BATCH_MS } = await import(
	'./editor.svelte.ts'
);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function open() {
	const root = await mkdtemp(join(tmpdir(), 'whispering-conflict-'));
	const folder = await openTestFolder(root, { commitOnEdit: false });
	cleanup.push(async () => {
		await folder.close();
		await rm(root, { recursive: true, force: true });
	});
	return folder;
}

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** What a reply to one save is: the folder's own, or one decided here. */
type Reply = 'answer' | 'lose' | 'refuse' | 'throw';

/**
 * The folder's own files, recording the text of every save sent and giving
 * each the next reply in `replies`. A lost reply follows a write that landed.
 */
function scripted(files: FolderFiles) {
	const script = {
		replies: [] as Reply[],
		/** Held until the test resolves it: a reply that has not arrived yet. */
		hold: undefined as Promise<void> | undefined,
		sent: [] as string[],
	};
	const wrapped: FolderFiles = {
		...files,
		async replace(file, content) {
			script.sent.push(
				typeof content === 'string' ? content : decoder.decode(content),
			);
			const reply = script.replies.shift() ?? 'answer';
			if (reply === 'throw') throw new Error('the folder host went away');
			if (reply === 'refuse')
				return FileError.Io({
					path: file.path,
					operation: 'replace',
					cause: new Error('disk full'),
				});
			const result = await files.replace(file, content);
			await script.hold;
			if (reply === 'lose' && result.error === null)
				return FileError.Unconfirmed({
					path: file.path,
					operation: 'replace',
					cause: 'reply lost after the write',
				});
			return result;
		},
	};
	return { files: wrapped, script };
}

/** A text file in the folder and a draft of it over `files`. */
async function draft(
	folder: Awaited<ReturnType<typeof open>>,
	files: FolderFiles,
	{ paused = false } = {},
) {
	const created = expectOk(await folder.files.create('note.md', 'original'));
	const counts = { saved: 0 };
	const editor = createTextFileEditor(
		files,
		{ ...created, source: 'original' },
		{ paused },
		() => {
			counts.saved += 1;
		},
	);
	cleanup.push(async () => editor.dispose());
	return { editor, counts };
}

/** The file as it is now, as a refresh hands it to the draft. */
async function current(folder: Awaited<ReturnType<typeof open>>) {
	const read = expectOk(await readTextFile(folder.files, 'note.md'));
	if (read.kind !== 'text') throw new Error('expected text');
	return read.file;
}

const pause = () => Bun.sleep(TYPING_BATCH_MS + 100);

// ============================================================================
// A save whose reply is lost
// ============================================================================

test('a save whose reply is lost stays unknown, and typing, a pause, settling, a reread, and disposal write nothing more', async () => {
	const folder = await open();
	const { files, script } = scripted(folder.files);
	const { editor, counts } = await draft(folder, files);
	script.replies.push('lose');

	editor.input('desired');
	expect(await editor.settle()).toBe(false);

	expect(editor.saveState).toMatchObject({ kind: 'unconfirmed' });
	expect(editor.unknown).toContain('reply lost');
	// The write landed; nothing is concluded from that.
	expect((await current(folder)).source).toBe('desired');
	expect(editor.baseline.source).toBe('original');
	expect(editor.dirty).toBe(true);
	expect(counts.saved).toBe(0);

	editor.input('desired, and more');
	await pause();
	expect(await editor.settle()).toBe(false);
	await editor.save();
	expect(script.sent).toEqual(['desired']);

	// The file holds the lost save's text: current content, shown for review.
	editor.observe(await current(folder));
	expect(editor.saveState).toMatchObject({
		kind: 'conflict',
		current: { source: 'desired' },
	});
	expect(editor.unknown).toContain('reply lost');
	expect(editor.buffer).toBe('desired, and more');
	expect(await editor.settle()).toBe(false);

	editor.dispose();
	await pause();
	expect(script.sent).toEqual(['desired']);
	expect((await current(folder)).source).toBe('desired');
	expect(counts.saved).toBe(0);
});

test('taking the file that holds a lost save’s text acknowledges it without calling that save confirmed', async () => {
	const folder = await open();
	const { files, script } = scripted(folder.files);
	const { editor } = await draft(folder, files);
	script.replies.push('lose');
	editor.input('desired');
	await editor.settle();
	editor.observe(await current(folder));

	editor.loadSaved();

	expect(editor.buffer).toBe('desired');
	expect(editor.dirty).toBe(false);
	expect(editor.saveState).toEqual({ kind: 'saved' });
	// Saving goes on again, and the lost save is still not known to have landed.
	expect(editor.unknown).toContain('reply lost');
	expect(await editor.settle()).toBe(true);
	expect(script.sent).toEqual(['desired']);

	// A later save's own receipt is what is confirmed.
	editor.input('desired, then saved');
	expect(await editor.settle()).toBe(true);
	expect(editor.unknown).toBeUndefined();
	expect(script.sent).toEqual(['desired', 'desired, then saved']);
});

test('trying again after a lost reply is one conditional save against the original baseline, and a file changed since is reviewed', async () => {
	const folder = await open();
	const { files, script } = scripted(folder.files);
	const { editor, counts } = await draft(folder, files);
	script.replies.push('lose');
	editor.input('desired');
	await editor.settle();
	editor.input('desired, and more');

	await editor.retry();

	// Sent once, against the file the draft was made on; the lost save had
	// changed it, so the folder refused and nothing was written over.
	expect(script.sent).toEqual(['desired', 'desired, and more']);
	expect(editor.saveState).toMatchObject({
		kind: 'conflict',
		current: { source: 'desired' },
	});
	expect((await current(folder)).source).toBe('desired');
	expect(editor.buffer).toBe('desired, and more');
	// In review, trying again is not offered; nothing is sent.
	await editor.retry();
	expect(script.sent).toHaveLength(2);

	// Keeping mine is one save over the version that was reviewed.
	await editor.keepMine();
	expect(script.sent).toEqual([
		'desired',
		'desired, and more',
		'desired, and more',
	]);
	expect(editor.saveState).toEqual({ kind: 'saved' });
	expect(editor.unknown).toBeUndefined();
	expect((await current(folder)).source).toBe('desired, and more');
	expect(counts.saved).toBe(1);
});

test('trying again after a lost reply that did not land saves once', async () => {
	const folder = await open();
	const { files: real, script } = scripted(folder.files);
	// The reply is lost before the write: nothing landed.
	const files: FolderFiles = {
		...real,
		async replace(file, content) {
			if (script.replies[0] !== 'lose') return real.replace(file, content);
			script.replies.shift();
			script.sent.push(decoder.decode(content as Uint8Array));
			return FileError.Unconfirmed({
				path: file.path,
				operation: 'replace',
				cause: 'reply lost before the write',
			});
		},
	};
	const { editor } = await draft(folder, files);
	script.replies.push('lose');
	editor.input('desired');
	await editor.settle();
	// A reread finds the file the draft was made on: still unknown, no review.
	editor.observe(await current(folder));
	expect(editor.saveState).toMatchObject({ kind: 'unconfirmed' });

	await editor.retry();

	expect(script.sent).toEqual(['desired', 'desired']);
	expect(editor.saveState).toEqual({ kind: 'saved' });
	expect((await current(folder)).source).toBe('desired');
});

// ============================================================================
// A save the folder refused, or that threw
// ============================================================================

for (const reply of ['refuse', 'throw'] as const)
	test(`a save that ${reply === 'refuse' ? 'the folder refused' : 'threw'} stops saving until the person tries again, once`, async () => {
		const folder = await open();
		const { files, script } = scripted(folder.files);
		const { editor, counts } = await draft(folder, files);
		script.replies.push(reply);

		editor.input('one');
		expect(await editor.settle()).toBe(false);
		expect(editor.saveState.kind).toBe('failed');
		editor.input('two');
		await pause();
		expect(await editor.settle()).toBe(false);
		expect(script.sent).toEqual(['one']);
		expect((await current(folder)).source).toBe('original');
		expect(editor.unknown).toBeUndefined();

		await editor.retry();
		expect(script.sent).toEqual(['one', 'two']);
		expect(editor.saveState).toEqual({ kind: 'saved' });
		expect((await current(folder)).source).toBe('two');
		expect(counts.saved).toBe(1);

		// Saving goes on by itself again after a confirmed save.
		editor.input('three');
		await pause();
		expect(script.sent).toEqual(['one', 'two', 'three']);
	});

// ============================================================================
// Saves that succeed
// ============================================================================

test('typing while a save is out stays typed, and is saved after it', async () => {
	const folder = await open();
	const { files, script } = scripted(folder.files);
	const { editor } = await draft(folder, files, { paused: true });
	const held = Promise.withResolvers<void>();
	script.hold = held.promise;

	editor.input('first');
	const saving = editor.save();
	await Bun.sleep(20);
	expect(editor.saveState.kind).toBe('saving');
	editor.input('first and second');
	script.hold = undefined;
	held.resolve();
	await saving;

	expect(editor.baseline.source).toBe('first');
	expect(editor.buffer).toBe('first and second');
	expect(editor.dirty).toBe(true);
	expect(editor.saveState).toEqual({ kind: 'saved' });

	await editor.save();
	expect(script.sent).toEqual(['first', 'first and second']);
	expect(editor.dirty).toBe(false);
	expect((await current(folder)).source).toBe('first and second');
});

test('a draft disposed while its save is out lets that save settle, then takes no typing and writes nothing', async () => {
	const folder = await open();
	const { files, script } = scripted(folder.files);
	const { editor } = await draft(folder, files, { paused: true });
	const held = Promise.withResolvers<void>();
	script.hold = held.promise;

	editor.input('sent before closing');
	const saving = editor.save();
	await Bun.sleep(20);
	editor.dispose();
	editor.input('typed after closing');
	script.hold = undefined;
	held.resolve();
	await saving;

	expect(editor.saveState).toEqual({ kind: 'saved' });
	expect(editor.buffer).toBe('sent before closing');
	expect(await editor.settle()).toBe(false);
	await pause();
	expect(script.sent).toEqual(['sent before closing']);
	expect((await current(folder)).source).toBe('sent before closing');
});

// ============================================================================
// Conflict reads
// ============================================================================

for (const failure of ['unreachable', 'binary'] as const) {
	test(`a conflict read that is ${failure} keeps input and allows a later reread`, async () => {
		const folder = await open();
		const saved = expectOk(await folder.files.create('note.md', 'original'));
		const { sha256 } = saved;
		let blocked = true;
		const files: FolderFiles = {
			...folder.files,
			read: (path) =>
				blocked && failure === 'unreachable'
					? Promise.resolve(
							FileError.Io({
								path,
								operation: 'read',
								cause: new Error('host unreachable'),
							}),
						)
					: folder.files.read(path),
		};
		const editor = createTextFileEditor(
			files,
			{ path: 'note.md', source: 'original', sha256 },
			{ paused: true },
			() => {},
		);
		cleanup.push(async () => editor.dispose());
		expectOk(
			await folder.files.replace(
				saved,
				failure === 'binary' ? new Uint8Array([0, 255]) : 'outside',
			),
		);
		editor.input('my typing');
		await editor.save();
		expect(editor.saveState.kind).toBe('failed');
		expect(editor.buffer).toBe('my typing');
		expect(editor.baseline.sha256).toEqual(sha256);
		blocked = false;
		expectOk(await folder.files.overwrite('note.md', 'outside'));
		await editor.retry();
		expect(editor.saveState).toMatchObject({
			kind: 'conflict',
			current: { source: 'outside' },
		});
		expect(editor.buffer).toBe('my typing');
	});
}

test('a file changed elsewhere to exactly the typed text is still reviewed, not taken as this draft’s save', async () => {
	const folder = await open();
	const { files, script } = scripted(folder.files);
	const { editor } = await draft(folder, files, { paused: true });
	editor.input('the same words');
	expectOk(await folder.files.overwrite('note.md', 'the same words'));

	await editor.save();

	expect(script.sent).toEqual(['the same words']);
	expect(editor.saveState).toMatchObject({
		kind: 'conflict',
		current: { source: 'the same words' },
	});
	expect(editor.baseline.source).toBe('original');
	editor.loadSaved();
	expect(editor.dirty).toBe(false);
	expect(editor.unknown).toBeUndefined();
});

// ============================================================================
// Text that cannot be encoded as typed
// ============================================================================

// A byte order mark, CRLF, and a surrogate pair are saved as typed. An
// unpaired surrogate cannot be: its bytes are the replacement character's.
const typedOver = (source: string) =>
	`﻿${source}lone \uD800 pair \u{1F600}\r\n`;
const storedFor = (typed: string) => typed.replace('\uD800', '�');

test('a file saved with an unpaired surrogate settles on the text of the bytes sent and is not sent again', async () => {
	const folder = await open();
	const { files, script } = scripted(folder.files);
	const { editor, counts } = await draft(folder, files, { paused: true });

	const typed = typedOver(editor.buffer);
	const stored = storedFor(typed);
	editor.input(typed);
	await editor.save();
	const read = expectOk(await folder.files.read(editor.path));
	expect(decoder.decode(read.bytes)).toBe(stored);
	expect(editor.baseline.source).toBe(stored);
	expect(editor.baseline.sha256).toBe(read.sha256);
	expect(editor.buffer).toBe(stored);
	expect(editor.dirty).toBe(false);
	expect(await editor.settle()).toBe(true);
	expect(counts.saved).toBe(1);

	// The capture is the file's, so the next save is accepted against it.
	editor.input(`${stored}more\n`);
	await editor.save();
	expect(editor.saveState).toEqual({ kind: 'saved' });
	expect(counts.saved).toBe(2);
	expect(script.sent).toHaveLength(2);
});

test('a save with an unpaired surrogate whose reply is lost keeps the typing as typed and its baseline unchanged', async () => {
	const folder = await open();
	const { files, script } = scripted(folder.files);
	const { editor } = await draft(folder, files, { paused: true });
	script.replies.push('lose');

	const typed = typedOver('');
	const stored = storedFor(typed);
	editor.input(typed);
	await editor.save();

	// The file holds the bytes that were sent; the draft does not take them.
	expect((await current(folder)).source).toBe(stored);
	expect(editor.saveState).toMatchObject({ kind: 'unconfirmed' });
	expect(editor.baseline.source).toBe('original');
	expect(editor.buffer).toBe(typed);
	editor.input(`${typed}newer \uD800`);
	await editor.save();
	expect(script.sent).toEqual([stored]);
	expect(editor.buffer).toBe(`${typed}newer \uD800`);
});
