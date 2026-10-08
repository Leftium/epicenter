/**
 * Captures Collection Tests
 *
 * Runs the real collection and draft modules over a real directory folder in a
 * temporary directory, with the folder's real row editors, and edits files on
 * disk as another program would.
 *
 * Key behaviors:
 * - Creating a capture writes the exact Markdown; opening and listing write
 *   nothing
 * - The timeline orders by the captured instant, not by its text
 * - A draft's save writes the whole canonical file at once; a listing never
 *   reads into an open draft, and the next save replaces an outside edit
 * - A save to a removed file fails and creates nothing; the file is put back
 *   only on request, and a file that came back is written over only by Try
 *   again
 * - Save as a copy creates a new file exclusively, leaves the original as it
 *   is, preserves BOM, CRLF, and Unicode, and lets go of its draft
 * - A capture with an unusual or empty file name is an ordinary capture
 * - A file whose text does not parse is listed, opens through its editor as
 *   Source, and is repaired there with no other writer
 * - Deleting settles the capture first, shows the file as it is then, and
 *   deletes exactly that, without reading it again
 * - Leaving fences every input and action at once, settles what saves on its
 *   own, counts what is held, and gives everything back when called off
 * - Closing finishes submitted saves and imports before the folder is let go
 */
import './svelte-modules.test-support.js';
import { afterAll, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDefinition } from '@epicenter/capture';
import { readLegacyBundle } from '@epicenter/capture/legacy';
import { type CommitOutcome, FileError, rowPath } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';
import fixture from '../../fixtures/legacy-bundle.json';
import type { Draft } from './draft.svelte.ts';

const { createCaptures } = await import('./captures.svelte.ts');

const roots: string[] = [];
afterAll(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function setup(options: { commit?: () => Promise<CommitOutcome> } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'capture-app-'));
	roots.push(root);
	const folder = expectOk(
		await openFolder({
			root,
			definition: captureDefinition,
			git: {
				author: { name: 'Test', email: 'test@localhost' },
				commitOnEdit: false,
			},
		}),
	);
	/** The next exact create waits for `held`. */
	const nextCreate: { held?: Promise<void> } = {};
	let heldCreate: Promise<void> | undefined;
	/** Ordinary file replacements: a capture's editor never uses them. */
	const replaced: string[] = [];
	/**
	 * How the next delete is answered: it throws, as a host that went away
	 * does; it lands and its answer is lost; or it is lost before it lands.
	 */
	let nextDelete: 'throws' | 'landed' | 'lost' | Promise<void> | undefined;
	/** The next acquisition is refused as unreadable, once. */
	let refuseNextEdit = false;
	/** Every exact create that reached the folder, by path. */
	const created: string[] = [];
	const captures = createCaptures({
		folder: {
			tables: {
				captures: {
					...folder.tables.captures,
					edit(stem, options) {
						if (!refuseNextEdit)
							return folder.tables.captures.edit(stem, options);
						refuseNextEdit = false;
						return Promise.resolve(
							FileError.Io({
								path: rowPath('captures', stem),
								operation: 'read',
								cause: new Error('the disk was busy'),
							}),
						);
					},
					async delete(stem, options) {
						const answer = nextDelete;
						nextDelete = undefined;
						if (answer instanceof Promise) {
							await answer;
							return folder.tables.captures.delete(stem, options);
						}
						if (answer === 'throws')
							throw new Error('Epicenter did not answer');
						if (answer === 'landed' || answer === 'lost') {
							if (answer === 'landed') {
								const removed = await folder.tables.captures.delete(
									stem,
									options,
								);
								if (removed.error !== null) return removed;
							}
							return FileError.Unconfirmed({
								path: rowPath('captures', stem),
								operation: 'removing',
								cause: new Error('the answer was lost'),
							});
						}
						return folder.tables.captures.delete(stem, options);
					},
					async create(options) {
						const held = heldCreate;
						heldCreate = undefined;
						await held;
						return folder.tables.captures.create(options);
					},
				},
			},
			files: {
				...folder.files,
				async create(path, content) {
					const { held } = nextCreate;
					nextCreate.held = undefined;
					await held;
					created.push(path);
					return folder.files.create(path, content);
				},
				replace(file, content) {
					replaced.push(file.path);
					return folder.files.replace(file, content);
				},
			},
			git: {
				get snapshot() {
					return folder.git.snapshot;
				},
				subscribe: folder.git.subscribe,
				commit: options.commit ?? folder.git.commit,
			},
		},
		location: folder.location,
	});
	const file = (stem: string) => join(root, 'captures', `${stem}.md`);
	async function create(text: string) {
		captures.inputNewCapture(text);
		const created = await captures.create();
		if (!created.ok) throw new Error(created.message);
		return created.stem;
	}
	/** The draft for a listed capture, once its editor has opened. */
	async function open(stem: string): Promise<Draft> {
		const draft = captures.open(stem);
		if (!draft) throw new Error(`no draft for ${stem}`);
		await draft.ready;
		return draft;
	}
	/** Review the capture for deletion: the file as the draft shows it. */
	async function review(draft: Draft) {
		if (!(await captures.reviewDeletion(draft)))
			throw new Error(draft.deletionProblem ?? 'no review');
		const entry = draft.deletionReview?.entry;
		if (entry === undefined) throw new Error('no review');
		return entry;
	}
	/** Review the capture for deletion and delete exactly what was shown. */
	async function deleteReviewed(draft: Draft) {
		await review(draft);
		return captures.remove(draft);
	}
	return {
		root,
		folder,
		captures,
		file,
		replaced,
		created,
		text: (stem: string) => readFile(file(stem), 'utf8'),
		exists: (stem: string) => Bun.file(file(stem)).exists(),
		create,
		open,
		review,
		deleteReviewed,
		/** Answer the next delete as `answer` says. */
		answerNextDelete(answer: 'throws' | 'landed' | 'lost') {
			nextDelete = answer;
		},
		/** Hold the next delete until the returned function is called; it then runs for real. */
		holdNextDelete() {
			const held = Promise.withResolvers<void>();
			nextDelete = held.promise;
			return held.resolve;
		},
		refuseNextEdit() {
			refuseNextEdit = true;
		},
		holdCaptureCreate() {
			const held = Promise.withResolvers<void>();
			heldCreate = held.promise;
			return held.resolve;
		},
		/** Hold the next exact create until the returned function is called. */
		holdNextCreate() {
			const held = Promise.withResolvers<void>();
			nextCreate.held = held.promise;
			return held.resolve;
		},
	};
}

/** The canonical frontmatter a save writes for a file created by Capture. */
function canonicalHead(source: string) {
	const at = /^capturedAt: (.*)$/m.exec(source)?.[1];
	if (at === undefined) throw new Error('no capturedAt');
	return `---\n"capturedAt": ${JSON.stringify(at)}\n---`;
}

test('creating writes exact Markdown; listing and opening write nothing', async () => {
	const { captures, create, open, text, file, folder } = await setup();
	const stem = await create('Dinner with Sebastian\nFriday at seven');
	const saved = await text(stem);
	expect(saved).toMatch(
		/^---\ncapturedAt: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n---\n\nDinner with Sebastian\nFriday at seven\n\n## Thoughts\n$/,
	);
	expect(captures.newCapture).toBe('');

	const before = (await Bun.file(file(stem)).stat()).mtimeMs;
	await captures.refresh();
	const draft = await open(stem);
	expect(draft.document.text).toBe('Dinner with Sebastian\nFriday at seven');
	expect(await captures.departure.settle()).toBe(0);
	expect(await text(stem)).toBe(saved);
	expect((await Bun.file(file(stem)).stat()).mtimeMs).toBe(before);
	expect(captures.unsettled).toBe(0);
	await captures.close();
	await folder.close();
});

test('a failed create keeps the text in the form', async () => {
	const { captures, folder } = await setup();
	await folder.close();
	captures.inputNewCapture('do not lose me');
	const created = await captures.create();
	expect(created.ok).toBe(false);
	expect(captures.newCapture).toBe('do not lose me');
	expect(captures.unsettled).toBe(1);
	await captures.close();
});

test('the timeline orders by the instant, across offsets, newest first', async () => {
	const { captures, file, folder, root } = await setup();
	await mkdir(join(root, 'captures'));
	const write = (stem: string, capturedAt: string) =>
		writeFile(file(stem), `---\ncapturedAt: ${capturedAt}\n---\n\n${stem}\n`);
	// 10:30+08:00 is 02:30Z: earlier than 03:00Z though its text sorts later.
	await write('offset', '2026-10-01T10:30:00+08:00');
	await write('utc', '2026-10-01T03:00:00.000Z');
	await write('oldest', '2026-09-30T23:00:00-02:00');
	await writeFile(
		file('broken'),
		'---\ncapturedAt: yesterday\n---\n\nbroken\n',
	);
	await captures.refresh();
	expect(captures.rows.map((row) => row.stem)).toEqual([
		'utc',
		'offset',
		'oldest',
		'broken',
	]);
	// A time that is not one is left out of the row and named as its problem.
	expect(captures.rows.at(-1)?.capturedAt).toBeUndefined();
	expect(captures.rows.at(-1)?.problem).toContain('capturedAt');
	await captures.close();
	await folder.close();
});

test('structured edits save as the whole canonical file, metadata Capture does not declare included, and reload as the same thoughts', async () => {
	const { captures, create, open, text, file, folder } = await setup();
	const stem = await create('Idea');
	const head = canonicalHead(await text(stem));
	await writeFile(
		file(stem),
		(await text(stem)).replace(
			'\n---\n',
			'\nsource: phone\nmeta:\n  tags: [a, b]\n---\n',
		),
	);
	await captures.refresh();
	const draft = await open(stem);
	for (const thought of ['one', 'two\nwith a second line', 'three']) {
		draft.inputNewThought(thought);
		expect(draft.addThought()).toBe(true);
	}
	const [, two, three] = draft.document.thoughts;
	if (!two || !three) throw new Error('fixture');
	expect(draft.swapThoughts(2, 1)).toBe(true);
	const first = draft.document.thoughts[0];
	if (!first) throw new Error('fixture');
	expect(draft.deleteThought(0)).toBe(true);
	await draft.settle();

	expect(await text(stem)).toBe(
		`${head.replace('\n---', '\n"meta": {"tags": ["a", "b"]}\n"source": "phone"\n---')}\n\nIdea\n\n## Thoughts\n\n- three\n- two\n  with a second line\n`,
	);
	expect(draft.unsettled).toBe(false);
	await captures.close();
	await folder.close();
});

test('a listing never reads into an open draft; Reload shows the file, and the next save replaces an outside edit', async () => {
	const { captures, create, open, text, file, folder } = await setup();
	const stem = await create('Original');
	const draft = await open(stem);
	const original = await text(stem);

	const outside = original.replace('Original', 'Edited in another program');
	await writeFile(file(stem), outside);
	await captures.refresh();
	// Loaded once: the open capture shows what it opened with, and asks nothing.
	expect(captures.draft(stem)).toBe(draft);
	expect(draft.text).toBe('Original');
	expect(draft.notice).toBeUndefined();
	expect(await draft.reload()).toBe(true);
	expect(draft.text).toBe('Edited in another program');
	expect(await text(stem)).toBe(outside);

	// The latest save wins over a change it never read.
	const again = outside.replace('Edited in another program', 'Edited again');
	await writeFile(file(stem), again);
	draft.inputText('My typing');
	expect(await captures.departure.settle()).toBe(0);
	expect(await text(stem)).toBe(
		`${canonicalHead(original)}\n\nMy typing\n\n## Thoughts\n`,
	);
	await captures.close();
	await folder.close();
});

test('a save to a removed file fails and creates nothing; the text stays, and is copied or put back only on request', async () => {
	const { captures, create, open, text, file, root, folder } = await setup();
	const removedStem = await create('Will be removed');
	const copiedStem = await create('Will be copied');
	const removed = await open(removedStem);
	const copied = await open(copiedStem);
	await rm(file(removedStem));
	await rm(file(copiedStem));
	removed.inputText('Typed after the file went away');
	copied.inputText('Typed after this one went away');
	const mine = { removed: removed.source, copied: copied.source };

	// Settling writes neither back; each save failed for its missing file.
	expect(await captures.departure.settle()).toBe(2);
	expect(removed.notice).toMatchObject({ kind: 'failed', missing: true });
	expect(copied.notice).toMatchObject({ kind: 'failed', missing: true });
	expect(await Bun.file(file(removedStem)).exists()).toBe(false);
	// The listing keeps both: each holds text that is not saved.
	await captures.refresh();
	expect(captures.rows.map((row) => [row.stem, row.attention]).sort()).toEqual(
		[
			[removedStem, 'failed'],
			[copiedStem, 'failed'],
		].sort(),
	);
	expect(removed.source).toBe(mine.removed);

	// A copy saves one beside it, exclusively, and lets go of the draft.
	const copy = await captures.saveCopy(copied);
	if (!copy.ok) throw new Error(copy.message);
	expect(await text(copy.stem)).toBe(mine.copied);
	expect(captures.draft(copiedStem)).toBeUndefined();
	expect(await Bun.file(file(copiedStem)).exists()).toBe(false);

	// The other is put back only when asked, through the same editor.
	expect(await removed.restore()).toEqual({ ok: true });
	expect(await text(removedStem)).toBe(mine.removed);
	expect(removed.notice).toBeUndefined();
	expect(removed.unsettled).toBe(false);
	expect((await readdir(join(root, 'captures'))).sort()).toEqual(
		[`${removedStem}.md`, `${copy.stem}.md`].sort(),
	);
	await captures.close();
	await folder.close();
});

test('a capture whose editor could not open is let go by the next listing, and opens again from the file', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	t.refuseNextEdit();
	const refused = await t.open(stem);
	expect(refused.loaded).toBe(false);
	expect(refused.refused?.message).toContain('the disk was busy');

	await t.captures.refresh();
	expect(t.captures.draft(stem)).toBeUndefined();
	const reopened = await t.open(stem);
	expect(reopened).not.toBe(refused);
	expect(reopened.text).toBe('Original');
	await t.captures.close();
	await t.folder.close();
});

for (const stem of ['bad ', ''])
	test(`a capture at the literal stem ${JSON.stringify(stem)} is an ordinary capture: opened, kept, and deleted at that file`, async () => {
		const { captures, create, open, text, file, folder, deleteReviewed } =
			await setup();
		// Valid source, saved by another program under an unusual name.
		const source = await text(await create('Original'));
		await writeFile(file(stem), source);
		await captures.refresh();
		const row = captures.rows.find(
			(item) => item.path === `captures/${stem}.md`,
		);
		expect(row?.stem).toBe(stem);
		// A name is an address, never a problem with the capture.
		expect(row?.problem).toBeUndefined();

		const draft = await open(stem);
		draft.inputText('My typing');
		await draft.settle();
		expect(draft.stem).toBe(stem);
		expect(await text(stem)).toContain('\nMy typing\n');

		expect(await deleteReviewed(draft)).toBe(true);
		expect(await Bun.file(file(stem)).exists()).toBe(false);
		await captures.close();
		await folder.close();
	});

test('a file whose text does not parse is listed, opens through its editor as Source, and is repaired there with no other writer', async () => {
	const { captures, create, open, text, file, folder, replaced } =
		await setup();
	const valid = await text(await create('Original'));
	const malformed = valid.replace(/capturedAt: .*/, 'capturedAt: [open');
	await writeFile(file('broken'), malformed);
	// Markdown with no frontmatter lines does not parse as a capture either.
	await writeFile(file('plain'), 'Just Markdown\n');
	await captures.refresh();

	// Both were read, so both are captures to open, each saying why it needs repair.
	for (const stem of ['broken', 'plain']) {
		const row = captures.rows.find((item) => item.stem === stem);
		expect(row?.problem).toBeDefined();
		expect(row?.capturedAt).toBeUndefined();
	}
	expect(captures.unreadable).toEqual([]);

	const draft = await open('broken');
	expect(draft.status).toBe('invalid');
	expect(draft.source).toBe(malformed);
	expect(draft.document.refusal?.code).toBe('unparsed');
	draft.inputNewThought('a thought');
	expect(draft.addThought()).toBe(false);
	draft.inputNewThought('');

	// Source saves as typed, through the same editor.
	draft.inputSource(valid);
	await draft.settle();
	expect(await text('broken')).toBe(valid);
	expect(draft.status).toBe('valid');
	expect(replaced).toEqual([]);
	await captures.refresh();
	const repaired = captures.rows.find((item) => item.stem === 'broken');
	expect(repaired?.problem).toBeUndefined();
	expect(repaired?.capturedAt).toBeInstanceOf(Date);
	await captures.close();
	await folder.close();
});

test('deleting settles the capture, shows the file as it is then, and deletes exactly that', async () => {
	const t = await setup();
	const stem = await t.create('To delete');
	const draft = await t.open(stem);
	// Typing saved first: the review shows it.
	draft.inputText('Typed, then deleted');
	const reviewed = await t.review(draft);
	expect(reviewed.text).toContain('\nTyped, then deleted\n');
	expect(await t.text(stem)).toBe(reviewed.text);

	expect(await t.captures.remove(draft)).toBe(true);
	expect(t.captures.draft(stem)).toBeUndefined();
	expect(draft.retired).toBe(true);
	expect(await t.captures.departure.settle()).toBe(0);
	expect(await t.exists(stem)).toBe(false);
	expect(t.captures.rows).toEqual([]);
	await t.captures.close();
	await t.folder.close();
});

test('a change made after the review is not deleted: the reviewed file is the condition, and nothing is read again', async () => {
	const t = await setup();
	const stem = await t.create('To delete');
	const draft = await t.open(stem);
	const reviewed = await t.review(draft);
	// Another program writes C after the person saw the file.
	const unseen = `${reviewed.text}\nadded outside\n`;
	await writeFile(t.file(stem), unseen);

	expect(await t.captures.remove(draft)).toBe(false);
	expect(await t.text(stem)).toBe(unseen);
	// Still held, now showing the file as it is, for another review.
	expect(draft.operation).toBe('deleting');
	expect(draft.deletionReview?.entry.text).toBe(unseen);
	expect(draft.deletionReview?.problem).toContain('changed since you reviewed');
	expect(await t.captures.remove(draft)).toBe(true);
	expect(await t.exists(stem)).toBe(false);
	await t.captures.close();
	await t.folder.close();
});

test('a review open when leaving begins sends nothing; a delete already sent is waited for', async () => {
	const t = await setup();
	const kept = await t.open(await t.create('Kept'));
	const sent = await t.open(await t.create('Sent'));
	await t.review(kept);
	await t.review(sent);
	const release = t.holdNextDelete();
	const sending = t.captures.remove(sent);
	expect(sent.removing).toBe(true);

	t.captures.departure.fence();
	// The open review is refused, its dialog stays, and its hold is kept.
	expect(await t.captures.remove(kept)).toBe(false);
	expect(await kept.confirmDeletion()).toBe(false);
	expect(kept.deletionReview?.problem).toContain('Nothing is deleted');
	expect(kept.operation).toBe('deleting');
	expect(await t.exists(kept.stem)).toBe(true);

	// The admitted one runs to its answer, and leaving waits for it.
	let settled = false;
	const settling = t.captures.departure.settle().then((held) => {
		settled = true;
		return held;
	});
	await Bun.sleep(10);
	expect(settled).toBe(false);
	release();
	expect(await sending).toBe(true);
	// The open review still holds one capture for the person.
	expect(await settling).toBe(1);
	expect(await t.exists(sent.stem)).toBe(false);
	expect(t.captures.draft(sent.stem)).toBeUndefined();

	t.captures.departure.resume();
	expect(await t.captures.remove(kept)).toBe(true);
	await t.captures.close();
	await t.folder.close();
});

test('a review called off while it reads is dropped when the read comes back', async () => {
	const t = await setup();
	const draft = await t.open(await t.create('Kept'));
	const reviewing = t.captures.reviewDeletion(draft);
	draft.cancelDeletion();
	expect(await reviewing).toBe(false);
	expect(draft.deletionReview).toBeUndefined();
	expect(draft.operation).toBeUndefined();
	expect(draft.admitted).toBe(true);
	await t.captures.close();
	await t.folder.close();
});

test('cancelling a deletion review gives the capture back as it was', async () => {
	const t = await setup();
	const stem = await t.create('Kept');
	const draft = await t.open(stem);
	draft.inputNewThought('held while reviewing');
	await t.review(draft);
	draft.inputNewThought('refused while reviewing');
	expect(draft.newThought).toBe('held while reviewing');
	draft.cancelDeletion();
	expect(draft.admitted).toBe(true);
	expect(draft.newThought).toBe('held while reviewing');
	expect(await t.exists(stem)).toBe(true);
	await t.captures.close();
	await t.folder.close();
});

test('a delete that throws gives the draft back, takes no typing for the file, and keeping the file is a choice', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const draft = await t.open(stem);
	await t.review(draft);
	t.answerNextDelete('throws');

	expect(await t.captures.remove(draft)).toBe(false);
	expect(t.captures.draft(stem)).toBe(draft);
	expect(draft.notice?.kind).toBe('deletion');
	// Whether the file is gone is not known, so typing is kept and not saved.
	draft.inputText('Typed after the delete');
	expect(draft.text).toBe('Typed after the delete');
	expect(draft.textIsPending).toBe(true);
	expect(draft.refusal).toContain('delete was not confirmed');
	expect(await t.captures.departure.settle()).toBe(1);
	expect(await t.text(stem)).not.toContain('Typed after the delete');

	// Keeping the file as it is now answers the delete; the kept text then applies.
	expect(await draft.reload()).toBe(true);
	expect(draft.notice).toBeUndefined();
	draft.inputText(draft.text);
	expect(draft.textIsPending).toBe(false);
	await draft.settle();
	expect(await t.text(stem)).toContain('\nTyped after the delete\n');
	await t.captures.close();
	await t.folder.close();
});

for (const landed of [true, false])
	test(`a delete answered Unconfirmed that ${landed ? 'landed' : 'did not land'} keeps the draft, writes nothing on its own, and waits for a choice`, async () => {
		const t = await setup();
		const stem = await t.create('Original');
		const draft = await t.open(stem);
		const reviewed = await t.review(draft);
		t.answerNextDelete(landed ? 'landed' : 'lost');

		expect(await t.captures.remove(draft)).toBe(false);
		expect(t.captures.draft(stem)).toBe(draft);
		expect(draft.admitted).toBe(true);
		expect(draft.notice?.kind).toBe('deletion');
		expect(draft.unsettled).toBe(true);

		// A listing, present or gone, keeps the draft and its question.
		await t.captures.refresh();
		expect(t.captures.draft(stem)).toBe(draft);
		expect(draft.notice?.kind).toBe('deletion');
		expect(t.captures.rows.find((row) => row.stem === stem)?.attention).toBe(
			'deletion',
		);
		expect(await t.captures.departure.settle()).toBe(1);
		expect(await t.exists(stem)).toBe(!landed);

		if (landed) {
			// Putting it back is the person's choice: the file as they reviewed it.
			expect(await draft.restore()).toEqual({ ok: true });
			expect(await t.text(stem)).toBe(reviewed.text);
			expect(draft.notice).toBeUndefined();
		} else {
			// Keeping the file as it is answers the delete; typing then saves.
			expect(await draft.reload()).toBe(true);
			expect(draft.notice).toBeUndefined();
			draft.inputText('After');
			await draft.settle();
			expect(await t.text(stem)).toContain('\nAfter\n');
		}
		await t.captures.close();
		await t.folder.close();
	});

test('a failed explicit commit keeps the saved file and its draft saved', async () => {
	const { captures, create, open, text, folder } = await setup({
		commit: async () => ({ status: 'failed', error: 'index is locked' }),
	});
	const stem = await create('Saved regardless');
	const draft = await open(stem);
	draft.inputText('Saved regardless of Git');
	await draft.settle();
	expect(draft.notice).toBeUndefined();
	expect(await text(stem)).toContain('Saved regardless of Git');
	expect((await captures.commit()).status).toBe('failed');
	expect(draft.notice).toBeUndefined();
	expect(captures.unsettled).toBe(0);
	await captures.close();
	await folder.close();
});

test('a draft whose file was removed stays open and on the timeline with its unsent input', async () => {
	const { captures, create, open, file, folder } = await setup();
	const stem = await create('Its file will go');
	const other = await create('Untouched neighbour');
	const draft = await open(stem);
	await open(other);
	// Nothing to save, but text typed and not added.
	draft.inputNewThought('typed, not added');

	await rm(file(stem));
	await rm(file(other));
	await captures.refresh();

	// The neighbour had nothing to lose and is let go. This one is kept.
	expect(captures.draft(other)).toBeUndefined();
	expect(captures.draft(stem)).toBe(draft);
	expect(draft.newThought).toBe('typed, not added');
	expect(
		captures.rows.map((row) => [row.stem, row.attention, row.unsettled]),
	).toEqual([[stem, undefined, true]]);
	expect(captures.unsettled).toBe(1);

	// A later listing does not drop it either.
	await captures.refresh();
	expect(captures.draft(stem)).toBe(draft);
	await captures.close();
	await folder.close();
});

test('save as a copy is refused, writing nothing, while unsent input would be dropped; otherwise it is all of the draft', async () => {
	const { captures, create, open, file, root, folder } = await setup();
	const stem = await create('Original');
	const initial = await readFile(file(stem), 'utf8');
	await writeFile(file(stem), `\uFEFF${initial.replaceAll('\n', '\r\n')}`);
	const draft = await open(stem);
	await rm(file(stem));
	const source = draft.source.replace(
		'\r\nOriginal\r\n',
		'\r\nMy draft, café 🍊\r\n',
	);
	draft.inputSource(source);
	draft.inputNewThought('typed, not added');
	await draft.settle();

	const refused = await captures.saveCopy(draft);
	expect(refused.ok).toBe(false);
	if (refused.ok) return;
	expect(refused.message).toContain('not in it yet');
	expect(await readdir(join(root, 'captures'))).toEqual([]);
	expect(captures.draft(stem)).toBe(draft);
	expect(draft.newThought).toBe('typed, not added');

	// Clearing it leaves only what is in Source: the copy carries all of it.
	draft.inputNewThought('');
	const copied = await captures.saveCopy(draft);
	if (!copied.ok) throw new Error(copied.message);
	const saved = await readFile(file(copied.stem), 'utf8');
	expect(saved).toBe(source);
	expect(captures.draft(stem)).toBeUndefined();
	// The original is not written back by letting go of the draft.
	expect(await Bun.file(file(stem)).exists()).toBe(false);
	await captures.close();
	await folder.close();
});

test('a copy holds the capture while it is written, so nothing typed meanwhile is lost or sent to the original', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const draft = await t.open(stem);
	draft.inputText('My text');
	const mine = draft.source;

	const release = t.holdNextCreate();
	const copying = t.captures.saveCopy(draft);
	await Bun.sleep(5);
	expect(draft.operation).toBe('copying');
	draft.inputText('typed while copying');
	draft.inputSource('typed while copying');
	draft.retry();
	expect(draft.source).toBe(mine);
	release();
	const copied = await copying;

	if (!copied.ok) throw new Error(copied.message);
	expect(await t.text(copied.stem)).toBe(mine);
	expect(t.captures.draft(stem)).toBeUndefined();
	// The original holds what was saved before the copy, and nothing after.
	expect(await t.text(stem)).toBe(mine);
	await t.captures.close();
	await t.folder.close();
});

test('whitespace typed into the new-capture form is refused and still protected', async () => {
	const { captures, folder } = await setup();
	captures.inputNewCapture('  \n');
	expect(captures.unsettled).toBe(1);
	const created = await captures.create();
	expect(created.ok).toBe(false);
	expect(captures.newCapture).toBe('  \n');
	expect(await captures.departure.settle()).toBe(1);
	expect(expectOk(await folder.files.list()).files).toEqual([]);
	captures.inputNewCapture('');
	expect(captures.unsettled).toBe(0);
	await captures.close();
	await folder.close();
});

test('leaving fences every input and action at once, settles what saves on its own, and gives everything back when called off', async () => {
	const t = await setup();
	const first = await t.open(await t.create('First'));
	const second = await t.open(await t.create('Second'));
	first.inputText('First, typed');
	second.inputNewThought('held: never added on its own');
	t.captures.inputNewCapture('a new capture, not added');

	t.captures.departure.fence();
	// Nothing is taken from the first moment, before anything is awaited.
	first.inputText('refused');
	second.inputNewThought('refused');
	t.captures.inputNewCapture('refused');
	expect(await t.captures.create()).toMatchObject({ ok: false });
	expect(await t.captures.saveCopy(first)).toMatchObject({ ok: false });
	expect(await t.captures.reviewDeletion(second)).toBe(false);
	expect(second.deletionReview).toBeUndefined();
	expect(first.text).toBe('First, typed');
	expect(second.newThought).toBe('held: never added on its own');

	// The typed text saves; held text stays held.
	expect(await t.captures.departure.settle()).toBe(2);
	expect(await t.text(first.stem)).toContain('\nFirst, typed\n');
	expect(second.document.thoughts).toEqual([]);
	expect(t.captures.newCapture).toBe('a new capture, not added');

	// Called off: everything is as it was, and input is taken again.
	t.captures.departure.resume();
	second.inputNewThought('held, then added');
	expect(second.addThought()).toBe(true);
	t.captures.inputNewCapture('');
	expect(await t.captures.departure.settle()).toBe(0);
	await t.captures.close();
	await t.folder.close();
});

test('settling waits for the submitted new capture and keeps text typed during its save', async () => {
	const t = await setup();
	t.captures.inputNewCapture('Submitted');
	const release = t.holdCaptureCreate();
	const creating = t.captures.create();
	const settled = t.captures.departure.settle();
	t.captures.inputNewCapture('Typed while saving');
	let finished = false;
	void settled.then(() => {
		finished = true;
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	release();
	const created = await creating;
	if (!created.ok) throw new Error(created.message);
	expect(await t.text(created.stem)).toContain('Submitted');
	expect(await settled).toBe(1);
	expect(t.captures.newCapture).toBe('Typed while saving');
	await t.captures.close();
	await t.folder.close();
});

test('closing finishes an entire import before detaching the real folder', async () => {
	const t = await setup();
	const read = readLegacyBundle(fixture);
	if (!read.ok) throw new Error('invalid fixture');
	const release = t.holdNextCreate();
	const importing = t.captures.importLegacy(read.bundle);
	expect(t.captures.unsettled).toBe(1);
	let closed = false;
	const closing = t.captures.close().then(async () => {
		await t.folder.close();
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	await expect(t.captures.importLegacy(read.bundle)).rejects.toThrow(
		'finishing',
	);
	release();
	const report = await importing;
	await closing;
	expect(report.complete).toBe(true);
	expect(report.receipt.status).toBe('written');
	expect(await readFile(join(t.root, report.receiptPath), 'utf8')).toContain(
		'legacy-import-receipt',
	);
});

test('closing waits for every accepted save before detaching', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const draft = await t.open(stem);
	draft.inputText('First');
	draft.inputText('Second');
	const closing = t.captures.close().then(() => t.folder.close());
	t.captures.inputNewCapture('After closing began');
	expect(await t.captures.create()).toMatchObject({ ok: false });
	draft.inputText('After closing began');
	await closing;
	expect(await t.text(stem)).toContain('\nSecond\n');
	expect(draft.retired).toBe(true);
});

test('a discarded draft whose save failed sends nothing again', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const draft = await t.open(stem);
	await rm(t.file(stem));
	draft.inputText('Discard me');
	await draft.settle();
	expect(draft.notice).toMatchObject({ kind: 'failed', missing: true });
	// The file comes back; nothing of the failed save reaches it.
	const back = await t.folder.files.create(
		rowPath('captures', stem),
		'---\ncapturedAt: 2026-10-01T02:30:00.000Z\n---\n\nBack\n',
	);
	expect(back.error).toBeNull();
	await t.captures.discard(draft);
	expect(draft.retired).toBe(true);
	draft.inputText('After it was let go');
	await t.captures.close();
	await t.folder.close();
	expect(await t.text(stem)).toContain('\nBack\n');
	expect(await t.text(stem)).not.toContain('Discard me');
});

/** A capture whose file another program removed, and whose save of `Mine` failed for it. */
async function removedWithText(t: Awaited<ReturnType<typeof setup>>) {
	const stem = await t.create('Original');
	const draft = await t.open(stem);
	await rm(t.file(stem));
	draft.inputText('Mine');
	const mine = draft.source;
	await draft.settle();
	const { notice } = draft;
	if (notice?.kind !== 'failed' || !notice.missing) throw new Error('fixture');
	return { stem, draft, mine };
}

for (const how of ['leaving', 'closing'] as const)
	test(`${how} waits for a restore already sent: its create and the reload after it`, async () => {
		const t = await setup();
		const { stem, draft, mine } = await removedWithText(t);
		const release = t.holdNextCreate();
		const restoring = draft.restore();
		// Held at once: nothing is typed into it while it restores.
		expect(draft.operation).toBe('restoring');
		draft.inputNewThought('refused');
		expect(draft.newThought).toBe('');

		let done = false;
		if (how === 'leaving') t.captures.departure.fence();
		const waiting = (
			how === 'leaving' ? t.captures.departure.settle() : t.captures.close()
		).then(() => {
			done = true;
		});
		await Bun.sleep(10);
		expect(done).toBe(false);
		release();
		expect(await restoring).toEqual({ ok: true });
		await waiting;
		expect(await t.text(stem)).toBe(mine);
		if (how === 'leaving') {
			// The reload finished before leaving settled: the editor holds the file.
			expect(draft.status).toBe('valid');
			expect(draft.unsettled).toBe(false);
			t.captures.departure.resume();
			await t.captures.close();
		} else expect(draft.retired).toBe(true);
		await t.folder.close();
	});

test('text a file cannot hold exactly is never put back or copied: nothing is written, and the text stays', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const draft = await t.open(stem);
	draft.setView('source');
	const lone = draft.source.replace('\nOriginal\n', '\nlone \uD800\n');
	draft.inputSource(lone);
	await draft.settle();
	// Accepted and shown, and its save failed instead of writing other bytes.
	expect(draft.status).toBe('invalid');
	expect(draft.rowProblem).toContain('lone surrogate');
	expect(draft.notice?.kind).toBe('failed');
	await rm(t.file(stem));
	const before = t.created.length;

	const restored = await draft.restore();
	expect(restored).toMatchObject({ ok: false });
	expect(!restored.ok && restored.message).toContain('cannot hold exactly');
	const copied = await t.captures.saveCopy(draft);
	expect(copied).toMatchObject({ ok: false });
	expect(t.created).toHaveLength(before);
	expect(await t.exists(stem)).toBe(false);
	// Still here, whole, and still this draft's.
	expect(t.captures.draft(stem)).toBe(draft);
	expect(draft.source).toBe(lone);
	expect(draft.retired).toBe(false);
	await t.captures.close();
	await t.folder.close();
});

test('a file that came back is not put back over; Try again explicitly writes over it', async () => {
	const t = await setup();
	const { stem, draft, mine } = await removedWithText(t);
	const C = `${mine.replace('Mine', 'Written by another program')}- with a thought\n`;
	await writeFile(t.file(stem), C);

	const restored = await draft.restore();
	expect(restored).toMatchObject({ ok: false });
	expect(!restored.ok && restored.message).toContain('nothing was written');
	expect(await t.text(stem)).toBe(C);
	// Leaving does not write over it either: no new input was submitted.
	expect(await t.captures.departure.settle()).toBe(1);
	expect(await t.text(stem)).toBe(C);

	draft.retry();
	await draft.settle();
	expect(draft.notice).toBeUndefined();
	expect(await t.text(stem)).toBe(mine);
	expect(mine).toContain('\nMine\n');
	await t.captures.close();
	await t.folder.close();
});
