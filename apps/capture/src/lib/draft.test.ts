/**
 * Capture Draft Tests
 *
 * Drives the real draft runes module over the real folder row editor, on a
 * directory folder in a temporary directory. Another program's edits are
 * plain writes to the file, and the draft is asked to read again, as a change
 * hint or a refresh would.
 *
 * Key behaviors:
 * - A save writes the whole canonical document as it was when the save
 *   started; typing during it stays dirty and saves next
 * - A clean draft follows a change made elsewhere and writes nothing; a dirty
 *   one keeps its text, stops saving, and each choice does one thing
 * - A file removed elsewhere is written back by the next save; a clean draft
 *   with nothing typed lets go of it
 * - A file changed into something that is not a capture stops saving, and
 *   can be taken into Source as a raw repair
 * - A file that cannot open as a row is raw source: written exactly, only on
 *   request, only over the version that was shown
 * - A Source edit below the frontmatter is a body change; a frontmatter edit
 *   is raw source that blocks structured edits until it is written or dropped
 * - Unsent thought text and refused capture text are unsettled
 * - A thought edit begun before the document changed is refused, text kept
 *
 * See also:
 * - `platform/folder.epicenter-host.test.ts` for failed and unconfirmed saves
 */
import './svelte-modules.test-support.js';
import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDefinition } from '@epicenter/capture';
import { inspectRow, openFolder } from '@epicenter/folder/bun';
import type { Draft, DraftStore } from './draft.svelte.ts';

const { createDraft } = await import('./draft.svelte.ts');

/** The raw source the draft holds, when it holds raw source. */
const rawOf = (draft: Draft) =>
	draft.mode.kind === 'raw' ? draft.mode : undefined;

const roots: string[] = [];
afterAll(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

const PATH = 'captures/one.md';
const AT = '2026-10-01T02:30:00.000Z';
/** The file as another program wrote it. */
const A = `---\ncapturedAt: ${AT}\n---\n\nA\n\n## Thoughts\n\n- first\n- second\n`;
/** The canonical file a save writes for capture text `text`. */
const canon = (text: string, thoughts = '- first\n- second\n') =>
	`---\n"capturedAt": "${AT}"\n---\n\n${text}\n\n## Thoughts\n\n${thoughts}`;
const D = A.replace('\nA\n', '\nD from outside\n');
const INVALID = A.replace(`capturedAt: ${AT}`, 'capturedAt: [open');

async function setup(initial: string | undefined = A) {
	const root = await mkdtemp(join(tmpdir(), 'capture-draft-'));
	roots.push(root);
	const opened = await openFolder({
		root,
		definition: captureDefinition,
		git: {
			author: { name: 'Test', email: 'test@localhost' },
			commitOnEdit: false,
		},
	});
	if (opened.error) throw new Error(opened.error.message);
	const folder = opened.data;
	const table = folder.tables.captures;
	const file = join(root, PATH);
	await mkdir(join(root, 'captures'));
	if (initial !== undefined) await writeFile(file, initial);

	const read: DraftStore['read'] = async () => {
		const found = await table.get('one');
		if (found.error !== null)
			return { kind: 'unreadable', message: found.error.message };
		if (found.data === undefined) return { kind: 'removed' };
		return { kind: 'present', entry: found.data };
	};
	/** Held before the next opening reads anything, or the next write throws. */
	const next: { edit?: Promise<void>; writeThrows?: Error } = {};
	const store: DraftStore = {
		inspect: (text) => inspectRow(captureDefinition.tables.captures, text),
		async edit(signal) {
			const held = next.edit;
			next.edit = undefined;
			await held;
			return table.edit('one', { signal });
		},
		read,
		async replace(capture, source) {
			const written = await table.replace('one', source, {
				expectedSha256: capture.sha256,
			});
			if (written.error !== null) return { data: null, error: written.error };
			// The receipt names the bytes sent; the entry is how they read.
			const entry = {
				...written.data,
				...inspectRow(captureDefinition.tables.captures, written.data.text),
			};
			return { data: entry, error: null };
		},
		async create(source) {
			const created = await folder.files.create(PATH, source);
			if (created.error !== null) return { data: null, error: created.error };
			const current = await read();
			if (current.kind !== 'present') throw new Error('not read back');
			return { data: current.entry, error: null };
		},
		async writing(work) {
			const thrown = next.writeThrows;
			next.writeThrows = undefined;
			// A host that went away throws instead of answering.
			if (thrown) throw thrown;
			return work();
		},
	};
	/** The source of each write the draft reported, in order. */
	const saved: string[] = [];
	const draft = createDraft(
		store,
		{ path: PATH, stem: 'one' },
		{ onSaved: (entry) => saved.push(entry.text), batchMs: 60_000 },
	);
	await draft.ready;
	return {
		draft,
		saved,
		next,
		store,
		table,
		disk: () => readFile(file, 'utf8'),
		outside: (source: string | undefined) =>
			source === undefined ? rm(file) : writeFile(file, source),
		async done() {
			await draft.dispose();
			await folder.close();
		},
	};
}

test('a save writes the document as it started; typing during it stays dirty and saves next', async () => {
	const t = await setup();
	t.draft.inputText('B');
	const saving = t.draft.save();
	t.draft.inputText('BC');
	await saving;

	expect(t.saved).toEqual([canon('B'), canon('BC')]);
	expect(await t.disk()).toBe(canon('BC'));
	expect(t.draft.dirty).toBe(false);
	expect(t.draft.unsettled).toBe(false);
	await t.done();
});

test('opening writes nothing, and a clean draft follows a change made elsewhere without writing', async () => {
	const t = await setup();
	expect(t.draft.mode.kind).toBe('editing');
	expect(t.draft.source).toBe(canon('A'));
	expect(await t.disk()).toBe(A);

	await t.outside(D);
	await t.draft.check();
	expect(t.draft.text).toBe('D from outside');
	expect(t.draft.dirty).toBe(false);
	expect(t.draft.notice).toBeUndefined();
	expect(t.saved).toEqual([]);
	expect(await t.disk()).toBe(D);
	await t.done();
});

test('a dirty draft keeps its text when the file changes elsewhere, stops saving, and each choice does one thing', async () => {
	const t = await setup();
	t.draft.inputText('mine');
	await t.outside(D);
	await t.draft.check();

	const notice = t.draft.notice;
	expect(notice?.kind).toBe('changed');
	expect(notice?.kind === 'changed' && notice.revision.text).toBe(D);
	expect(t.draft.text).toBe('mine');
	// Typing does not save over it by itself.
	await t.draft.save();
	expect(t.saved).toEqual([]);
	expect(await t.disk()).toBe(D);
	expect(t.draft.unsettled).toBe(true);

	// Keeping mine writes the whole draft over what was shown.
	await t.draft.saveMine();
	expect(await t.disk()).toBe(canon('mine'));
	expect(t.draft.notice).toBeUndefined();
	expect(t.draft.unsettled).toBe(false);

	// Loading the saved file drops my input instead, and writes nothing.
	t.draft.inputText('discard me');
	await t.outside(D);
	await t.draft.check();
	t.draft.loadSaved();
	expect(t.draft.text).toBe('D from outside');
	expect(t.draft.dirty).toBe(false);
	expect(await t.disk()).toBe(D);
	await t.done();
});

test('a file removed elsewhere is written back by the next save; a clean draft lets it go', async () => {
	const dirty = await setup();
	dirty.draft.inputText('mine');
	await dirty.outside(undefined);
	await dirty.draft.check();
	expect(dirty.draft.editor?.observation.kind).toBe('missing');
	expect(dirty.draft.notice).toBeUndefined();
	expect(dirty.draft.gone).toBe(false);
	await dirty.draft.save();
	expect(await dirty.disk()).toBe(canon('mine'));
	await dirty.done();

	const clean = await setup();
	await clean.outside(undefined);
	await clean.draft.check();
	expect(clean.draft.gone).toBe(true);
	expect(clean.draft.unsettled).toBe(false);
	await clean.done();
});

test('a file changed elsewhere into one that is not a capture stops saving, and can be repaired as Source', async () => {
	const t = await setup();
	t.draft.inputText('mine');
	await t.outside(INVALID);
	await t.draft.check();
	expect(t.draft.notice?.kind).toBe('invalid');
	await t.draft.save();
	expect(await t.disk()).toBe(INVALID);

	await t.draft.repairFile();
	expect(rawOf(t.draft)?.reason).toBeDefined();
	expect(t.draft.source).toBe(INVALID);
	expect(t.draft.unsettled).toBe(false);
	t.draft.inputSource(D);
	expect(t.draft.unsettled).toBe(true);
	await t.draft.writeRaw();

	// Written exactly, then opened again as a capture.
	expect(await t.disk()).toBe(D);
	expect(t.draft.mode.kind).toBe('editing');
	expect(t.draft.text).toBe('D from outside');
	await t.done();
});

test('a file that cannot open as a row is raw source, written exactly and only over the version shown', async () => {
	const t = await setup(INVALID);
	expect(rawOf(t.draft)?.reason).toBeDefined();
	expect(t.draft.source).toBe(INVALID);
	expect(t.draft.structured).toBe(false);
	t.draft.newThought = 'a thought';
	expect(t.draft.addThought()).toBe(false);
	t.draft.newThought = '';

	const edited = INVALID.replace('\nA\n', '\nA, edited\n');
	t.draft.inputSource(edited);
	// Raw source is written only when asked.
	await t.draft.save();
	expect(await t.disk()).toBe(INVALID);

	// Another program changes the file first: nothing is written, and it is shown.
	const other = INVALID.replace('\nA\n', '\nchanged outside\n');
	await t.outside(other);
	await t.draft.writeRaw();
	expect(await t.disk()).toBe(other);
	expect(rawOf(t.draft)?.text).toBe(edited);
	expect(rawOf(t.draft)?.problem).toContain('changed outside this window');
	const over = rawOf(t.draft)?.over;
	expect(typeof over === 'object' && over.text).toBe(other);

	// Saving again replaces the version that was shown, exactly as typed.
	await t.draft.writeRaw();
	expect(await t.disk()).toBe(edited);
	expect(rawOf(t.draft)?.reason).toBeDefined();
	expect(t.draft.unsettled).toBe(false);
	await t.done();
});

test('a Source edit below the frontmatter saves as typing; a frontmatter edit waits for an explicit write', async () => {
	const t = await setup();
	t.draft.inputSource(t.draft.source.replace('\nA\n', '\nA, in Source\n'));
	expect(t.draft.mode.kind).toBe('editing');
	await t.draft.save();
	expect(await t.disk()).toBe(canon('A, in Source'));

	const withKey = t.draft.source.replace(
		'\n---\n',
		'\n"unknownKey": "kept"\n---\n',
	);
	t.draft.inputSource(withKey);
	expect(rawOf(t.draft)?.text).toBe(withKey);
	expect(t.draft.structured).toBe(false);
	t.draft.newThought = 'blocked';
	expect(t.draft.addThought()).toBe(false);
	expect(t.draft.newThought).toBe('blocked');
	t.draft.newThought = '';
	await t.draft.save();
	expect(await t.disk()).toBe(canon('A, in Source'));

	await t.draft.writeRaw();
	expect(await t.disk()).toBe(withKey);
	expect(t.draft.mode.kind).toBe('editing');

	// The key it does not declare is kept by every later save.
	t.draft.inputText('B');
	await t.draft.save();
	expect(await t.disk()).toBe(
		canon('B').replace('\n---\n\n', '\n"unknownKey": "kept"\n---\n\n'),
	);
	await t.done();
});

test('a frontmatter edit replaces only the version shown: a later change elsewhere is refused and shown, never overwritten', async () => {
	const t = await setup();
	t.draft.newThought = 'typed, not added';
	const withKey = t.draft.source.replace(
		'\n---\n',
		'\n"unknownKey": "kept"\n---\n',
	);
	t.draft.inputSource(withKey);
	await t.draft.idle();
	// The text is raw now: nothing follows the file, and unsent input stays.
	const shown = rawOf(t.draft)?.over;
	expect(typeof shown === 'object' && shown.text).toBe(A);
	expect(t.draft.newThought).toBe('typed, not added');

	await t.outside(D);
	await t.draft.check();
	expect(rawOf(t.draft)?.text).toBe(withKey);
	await t.draft.writeRaw();
	expect(await t.disk()).toBe(D);
	expect(rawOf(t.draft)?.problem).toContain('changed outside this window');
	const now = rawOf(t.draft)?.over;
	expect(typeof now === 'object' && now.text).toBe(D);
	expect(rawOf(t.draft)?.text).toBe(withKey);
	await t.done();
});

test('raw text typed while a raw write is out stays, over what was written, for another explicit write', async () => {
	const t = await setup(INVALID);
	const first = INVALID.replace('\nA\n', '\nfirst\n');
	t.draft.inputSource(first);
	const writing = t.draft.writeRaw();
	const second = INVALID.replace('\nA\n', '\nsecond\n');
	t.draft.inputSource(second);
	await writing;

	expect(await t.disk()).toBe(first);
	expect(rawOf(t.draft)?.text).toBe(second);
	const over = rawOf(t.draft)?.over;
	expect(typeof over === 'object' && over.text).toBe(first);
	expect(t.draft.unsettled).toBe(true);
	await t.draft.save();
	expect(await t.disk()).toBe(first);

	await t.draft.writeRaw();
	expect(await t.disk()).toBe(second);
	await t.done();
});

test('unsent thought text and refused capture text are unsettled until resolved', async () => {
	const t = await setup();
	expect(t.draft.unsettled).toBe(false);
	t.draft.newThought = 'not added yet';
	expect(t.draft.unsettled).toBe(true);
	expect(await t.draft.settle()).toBe(false);
	expect(t.draft.addThought()).toBe(true);
	expect(t.draft.newThought).toBe('');
	await t.draft.save();
	expect(await t.disk()).toBe(
		canon('A', '- first\n- second\n- not added yet\n'),
	);
	expect(t.draft.unsettled).toBe(false);

	// An unclosed fence would absorb the section: the text is kept, not applied.
	t.draft.inputText('A\n```\nopen');
	expect(t.draft.textIsPending).toBe(true);
	expect(t.draft.text).toBe('A\n```\nopen');
	expect(t.draft.refusal).toContain('would not read back');
	expect(t.draft.dirty).toBe(false);
	expect(t.draft.unsettled).toBe(true);
	t.draft.inputText('A\n```\nopen\n```');
	expect(t.draft.textIsPending).toBe(false);
	expect(t.draft.document.text).toBe('A\n```\nopen\n```');

	// Text the file cannot hold is refused by the editor and kept here.
	t.draft.inputText('lone \uD800');
	expect(t.draft.textIsPending).toBe(true);
	expect(t.draft.refusal).toContain('lone surrogate');
	await t.done();
});

test('storage that throws instead of answering is a failed save: typing does not resend it, Try again does', async () => {
	const t = await setup();
	t.next.writeThrows = new Error('Epicenter did not answer');
	t.draft.inputText('mine');
	await t.draft.save();
	expect(t.draft.notice).toEqual({
		kind: 'failed',
		message: 'Epicenter did not answer',
	});
	expect(await t.disk()).toBe(A);

	t.draft.inputText('mine, more');
	await t.draft.save();
	expect(t.saved).toEqual([]);
	expect(await t.draft.settle()).toBe(false);

	await t.draft.saveMine();
	expect(await t.disk()).toBe(canon('mine, more'));
	expect(t.draft.notice).toBeUndefined();
	expect(t.draft.unsettled).toBe(false);
	await t.done();
});

test('a draft let go while its editor opens takes no editor and saves nothing', async () => {
	const t = await setup();
	await t.draft.dispose();
	const opening = Promise.withResolvers<void>();
	t.next.edit = opening.promise;
	const late = createDraft(
		t.store,
		{ path: PATH, stem: 'one' },
		{ onSaved: (entry) => t.saved.push(entry.text), batchMs: 60_000 },
	);
	late.newThought = 'typed while opening';
	const disposing = late.dispose();
	opening.resolve();
	await disposing;
	await late.ready;

	expect(late.mode.kind).toBe('opening');
	expect(late.addThought()).toBe(false);
	await late.save();
	expect(t.saved).toEqual([]);
	expect(await t.disk()).toBe(A);
	await t.done();
});

test('a thought edit begun before the document changed is refused and its text kept', async () => {
	const t = await setup();
	const [first, second] = t.draft.document.thoughts;
	if (!first || !second) throw new Error('fixture');
	t.draft.startEditing(first);
	t.draft.inputEditing('first, edited');
	// Something else changes the document: a different parse.
	t.draft.inputText('A changed');
	expect(t.draft.commitEditing()).toBe(false);
	expect(t.draft.editing?.text).toBe('first, edited');
	expect(t.draft.refusal).toContain('changed since this thought was shown');
	expect(t.draft.document.thoughts.map((thought) => thought.text)).toEqual([
		'first',
		'second',
	]);
	// The stale operands are refused for delete and for both sides of a swap.
	expect(t.draft.deleteThought(first)).toBe(false);
	const [nowFirst, nowSecond] = t.draft.document.thoughts;
	if (!nowFirst || !nowSecond) throw new Error('fixture');
	expect(t.draft.swapThoughts(first, nowSecond)).toBe(false);
	expect(t.draft.swapThoughts(nowFirst, second)).toBe(false);
	expect(t.draft.swapThoughts(nowFirst, nowSecond)).toBe(true);
	expect(t.draft.document.thoughts.map((thought) => thought.text)).toEqual([
		'second',
		'first',
	]);
	await t.done();
});
