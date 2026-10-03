/**
 * Captures Collection Tests
 *
 * Runs the real collection and draft modules over a real directory folder in a
 * temporary directory, and edits files on disk as another program would.
 *
 * Key behaviors:
 * - Creating a capture writes the exact Markdown; opening and listing write
 *   nothing
 * - The timeline orders by the captured instant, not by its text
 * - A draft's save writes the whole canonical file; a listing makes each
 *   draft read its file again, so a clean draft follows an outside edit and a
 *   dirty one keeps its text and waits for a choice
 * - A removed file and an unreadable file are reported differently; a draft
 *   with input whose file was removed stays on the timeline, and its next save
 *   writes it back
 * - Save as a copy writes the draft at a new path and never touches the
 *   original; it lets go of the draft only when the copy holds all of it
 * - A capture with an unusual or empty file name is an ordinary capture
 * - A file whose text does not parse is still listed, opens as raw source,
 *   and is repaired there
 * - Deleting removes exactly the reviewed file, refuses one that changed, and
 *   is never undone by a pending save
 * - Closing finishes submitted saves and imports; discarding publishes
 *   nothing typed after a save was submitted
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
import { type CommitOutcome, FileError } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/bun';
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
	/**
	 * The next exact create, played in a fixed order: it waits for `held`, and
	 * once the folder has published it, `afterCreate` runs as another program
	 * would, before the collection reads anything back.
	 */
	const nextCreate: {
		held?: Promise<void>;
		afterCreate?: () => Promise<unknown>;
	} = {};
	let heldCreate: Promise<void> | undefined;
	/**
	 * How the next delete is answered: it throws, as a host that went away
	 * does; it lands and its answer is lost; it is lost before it lands; or it
	 * waits for a promise and then runs for real.
	 */
	let nextDelete: 'throws' | 'landed' | 'lost' | Promise<void> | undefined;
	const captures = createCaptures(
		{
			folder: {
				tables: {
					captures: {
						...folder.tables.captures,
						async delete(capture) {
							const answer = nextDelete;
							nextDelete = undefined;
							if (answer === 'throws')
								throw new Error('Epicenter did not answer');
							if (answer === 'landed' || answer === 'lost') {
								if (answer === 'landed') {
									const removed = await folder.tables.captures.delete(capture);
									if (removed.error !== null) return removed;
								}
								return FileError.Unconfirmed({
									path: capture.path,
									operation: 'removing',
									cause: new Error('the answer was lost'),
								});
							}
							await answer;
							return folder.tables.captures.delete(capture);
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
						const { held, afterCreate } = nextCreate;
						nextCreate.held = nextCreate.afterCreate = undefined;
						await held;
						const created = await folder.files.create(path, content);
						if (created.error === null) await afterCreate?.();
						return created;
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
		},
		{ batchMs: 60_000 },
	);
	const file = (stem: string) => join(root, 'captures', `${stem}.md`);
	async function create(text: string) {
		captures.newCapture = text;
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
	return {
		root,
		folder,
		captures,
		file,
		text: (stem: string) => readFile(file(stem), 'utf8'),
		create,
		open,
		/** Answer the next delete as `answer` says. */
		answerNextDelete(answer: 'throws' | 'landed' | 'lost') {
			nextDelete = answer;
		},
		/** Hold the next delete until the returned function is called. */
		holdNextDelete() {
			const held = Promise.withResolvers<void>();
			nextDelete = held.promise;
			return held.resolve;
		},
		holdCaptureCreate() {
			let release!: () => void;
			heldCreate = new Promise<void>((resolve) => {
				release = resolve;
			});
			return release;
		},
		/** Hold the next exact create until the returned function is called. */
		holdNextCreate() {
			let release!: () => void;
			nextCreate.held = new Promise<void>((resolve) => {
				release = resolve;
			});
			return release;
		},
		/** A draft with unsaved typing whose file another program removed. */
		async removedDraft() {
			const stem = await create('Original');
			const draft = await open(stem);
			draft.inputText('My draft');
			draft.newThought = 'a thought';
			if (!draft.addThought()) throw new Error('fixture');
			await rm(file(stem));
			await captures.refresh();
			if (draft.editor?.observation.kind !== 'missing')
				throw new Error('fixture');
			return { stem, draft, mine: draft.source };
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
	await captures.settleAll();
	expect(await text(stem)).toBe(saved);
	expect((await Bun.file(file(stem)).stat()).mtimeMs).toBe(before);
	expect(captures.unsettled).toBe(0);
	await captures.close();
	await folder.close();
});

test('a failed create keeps the text in the form', async () => {
	const { captures, folder } = await setup();
	await folder.close();
	captures.newCapture = 'do not lose me';
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
	const broken = (await folder.tables.captures.get('broken')).data;
	expect(broken?.fields).toEqual({});
	expect(broken?.issues.map((issue) => issue.field)).toEqual(['capturedAt']);
	await captures.close();
	await folder.close();
});

test('structured edits save as the whole canonical file and reload as the same thoughts', async () => {
	const { captures, create, open, text, folder } = await setup();
	const stem = await create('Idea');
	const head = canonicalHead(await text(stem));
	const draft = await open(stem);
	for (const thought of ['one', 'two\nwith a second line', 'three']) {
		draft.newThought = thought;
		expect(draft.addThought()).toBe(true);
	}
	const [, two, three] = draft.document.thoughts;
	if (!two || !three) throw new Error('fixture');
	expect(draft.swapThoughts(three, two)).toBe(true);
	const first = draft.document.thoughts[0];
	if (!first) throw new Error('fixture');
	expect(draft.deleteThought(first)).toBe(true);
	await draft.save();

	expect(await text(stem)).toBe(
		`${head}\n\nIdea\n\n## Thoughts\n\n- three\n- two\n  with a second line\n`,
	);
	expect(draft.unsettled).toBe(false);
	await captures.close();
	await folder.close();
});

test('a listing makes a clean draft follow an outside edit and a dirty one wait for a choice', async () => {
	const { captures, create, open, text, file, folder } = await setup();
	const stem = await create('Original');
	const draft = await open(stem);
	const original = await text(stem);

	const outside = original.replace('Original', 'Edited in another program');
	await writeFile(file(stem), outside);
	await captures.refresh();
	expect(draft.text).toBe('Edited in another program');
	expect(draft.notice).toBeUndefined();
	expect(await text(stem)).toBe(outside);

	draft.inputText('My unsaved typing');
	const again = outside.replace('Edited in another program', 'Edited again');
	await writeFile(file(stem), again);
	await captures.refresh();
	expect(draft.text).toBe('My unsaved typing');
	const notice = draft.notice;
	expect(notice?.kind === 'changed' && notice.revision.source).toBe(again);
	expect(captures.rows.find((row) => row.stem === stem)?.attention).toBe(
		'changed',
	);
	expect(await captures.settleAll()).toBe(1);
	expect(await text(stem)).toBe(again);

	await draft.saveMine();
	expect(await text(stem)).toBe(
		`${canonicalHead(original)}\n\nMy unsaved typing\n\n## Thoughts\n`,
	);
	expect(captures.unsettled).toBe(0);
	await captures.close();
	await folder.close();
});

test('a save overwrites an outside edit this window had not read yet', async () => {
	const { captures, create, open, text, file, folder } = await setup();
	const stem = await create('Original');
	const draft = await open(stem);
	draft.inputText('Mine');
	await writeFile(
		file(stem),
		(await text(stem)).replace('Original', 'Not read here'),
	);
	await draft.save();
	expect(await text(stem)).toContain('\nMine\n');
	expect(draft.unsettled).toBe(false);
	await captures.close();
	await folder.close();
});

test('removed and unreadable files are told apart; a copy keeps one draft and a save writes the other back', async () => {
	const { captures, create, open, text, file, root, folder } = await setup();
	const removedStem = await create('Will be removed');
	const brokenStem = await create('Will be unreadable');
	const removed = await open(removedStem);
	const broken = await open(brokenStem);
	removed.inputText('Typed before the file went away');
	broken.inputText('Typed before the file broke');

	await rm(file(removedStem));
	await writeFile(file(brokenStem), new Uint8Array([0xff, 0xfe, 0x00]));
	await captures.refresh();

	expect(removed.notice).toBeUndefined();
	expect(removed.editor?.observation.kind).toBe('missing');
	expect(broken.notice?.kind).toBe('unreadable');
	expect(
		captures.rows.map((row) => [row.stem, row.attention]).sort(),
	).toEqual(
		[
			[removedStem, 'removed'],
			[brokenStem, 'unreadable'],
		].sort(),
	);
	expect(captures.unreadable.map((item) => item.path)).toEqual([
		`captures/${brokenStem}.md`,
	]);

	// Settling saves what may be saved: the removed file is written back, and
	// the unreadable one is not saved over.
	expect(await captures.settleAll()).toBe(1);
	expect(await text(removedStem)).toContain('Typed before the file went away');
	expect(removed.unsettled).toBe(false);
	expect(new Uint8Array(await readFile(file(brokenStem)))).toEqual(
		new Uint8Array([0xff, 0xfe, 0x00]),
	);

	// A copy saves the other draft beside it.
	const copy = await captures.saveCopy(broken);
	if (!copy.ok) throw new Error(copy.message);
	expect(await text(copy.stem)).toContain('Typed before the file broke');
	expect(captures.draft(brokenStem)).toBeUndefined();
	expect((await readdir(join(root, 'captures'))).sort()).toEqual(
		[`${removedStem}.md`, `${brokenStem}.md`, `${copy.stem}.md`].sort(),
	);
	await captures.close();
	await folder.close();
});

for (const stem of ['bad ', ''])
	test(`a capture at the literal stem ${JSON.stringify(stem)} is an ordinary capture: opened, kept, written back, and deleted at that file`, async () => {
		const { captures, create, open, text, file, folder } = await setup();
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
		const outside = source.replace('Original', 'Edited outside');
		await writeFile(file(stem), outside);
		await draft.check();
		expect(draft.notice?.kind).toBe('changed');
		expect(draft.text).toBe('My typing');
		expect(await text(stem)).toBe(outside);

		// Removed outside, the draft's next save writes it back at the same file.
		await rm(file(stem));
		await draft.check();
		await draft.save();
		expect(draft.stem).toBe(stem);
		expect(await text(stem)).toContain('\nMy typing\n');

		const reviewed = await captures.reviewDeletion(stem);
		if (!reviewed.ok) throw new Error(reviewed.message);
		expect(await captures.remove(reviewed.entry)).toEqual({ ok: true });
		expect(await Bun.file(file(stem)).exists()).toBe(false);
		await captures.close();
		await folder.close();
	});

test('a file whose text does not parse is listed, opens as raw source, and is repaired there', async () => {
	const { captures, create, open, text, file, folder } = await setup();
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
	expect(draft.mode.kind).toBe('raw');
	expect(draft.source).toBe(malformed);
	expect(draft.reading.parseError).toBeDefined();
	expect(draft.document.refusal?.code).toBe('unparsed');
	// No text or thought is read from it, and no structured edit applies.
	expect(draft.document.text).toBeUndefined();
	draft.newThought = 'a thought';
	expect(draft.addThought()).toBe(false);
	expect(draft.source).toBe(malformed);
	draft.newThought = '';

	// Still malformed text is written as typed, when asked.
	const still = malformed.replace('Original', 'Original, edited');
	draft.inputSource(still);
	await draft.writeRaw();
	expect(await text('broken')).toBe(still);
	expect(draft.mode.kind).toBe('raw');
	expect(draft.unsettled).toBe(false);

	// A field that needs fixing is described for the text on screen.
	draft.inputSource(still.replace('[open', 'soon'));
	expect(draft.reading.parseError).toBeUndefined();
	expect(draft.reading.issues.map((issue) => issue.field)).toEqual([
		'capturedAt',
	]);

	draft.inputSource(valid);
	expect(draft.reading).toMatchObject({ parseError: undefined, issues: [] });
	await draft.writeRaw();
	expect(await text('broken')).toBe(valid);
	expect(draft.mode.kind).toBe('editing');
	expect(draft.structured).toBe(true);
	await captures.refresh();
	const repaired = captures.rows.find((item) => item.stem === 'broken');
	expect(repaired?.problem).toBeUndefined();
	expect(repaired?.capturedAt).toBeInstanceOf(Date);
	await captures.close();
	await folder.close();
});

test('deleting removes the reviewed file and refuses one that changed since', async () => {
	const { captures, create, text, file, folder } = await setup();
	const stem = await create('To delete');
	const reviewed = await captures.reviewDeletion(stem);
	if (!reviewed.ok) throw new Error(reviewed.message);

	await writeFile(file(stem), `${reviewed.entry.source}\nadded outside\n`);
	const refused = await captures.remove(reviewed.entry);
	expect(refused).toMatchObject({ ok: false, changed: true });
	expect(await text(stem)).toContain('added outside');

	const again = await captures.reviewDeletion(stem);
	if (!again.ok) throw new Error(again.message);
	expect(await captures.remove(again.entry)).toEqual({ ok: true });
	expect(await Bun.file(file(stem)).exists()).toBe(false);
	expect(captures.rows).toEqual([]);
	await captures.close();
	await folder.close();
});

test('deleting a capture with unsaved typing leaves no save behind to write it back', async () => {
	const { captures, create, open, file, folder } = await setup();
	const stem = await create('To delete');
	const draft = await open(stem);
	draft.inputText('Typed, then deleted');
	const reviewed = await captures.reviewDeletion(stem);
	if (!reviewed.ok) throw new Error(reviewed.message);
	expect(await captures.remove(reviewed.entry)).toEqual({ ok: true });
	expect(captures.draft(stem)).toBeUndefined();
	await draft.save();
	expect(await captures.settleAll()).toBe(0);
	expect(await Bun.file(file(stem)).exists()).toBe(false);
	await captures.close();
	await folder.close();
});

test('a delete that throws gives the draft back, saves nothing on its own, and the next explicit save works', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const draft = await t.open(stem);
	draft.inputText('Typed before the delete');
	const reviewed = await t.captures.reviewDeletion(stem);
	if (!reviewed.ok) throw new Error(reviewed.message);
	t.answerNextDelete('throws');

	expect(await t.captures.remove(reviewed.entry)).toMatchObject({
		ok: false,
		changed: false,
	});
	expect(t.captures.draft(stem)).toBe(draft);
	// Whether the file is gone is not known, so typing does not save it back.
	expect(draft.outcome?.kind).toBe('deletion');
	expect(draft.editor?.lastSave).toBeUndefined();
	await draft.save();
	expect(await t.text(stem)).not.toContain('Typed before the delete');

	await draft.saveMine();
	expect(await t.text(stem)).toContain('\nTyped before the delete\n');
	expect(draft.outcome).toBeUndefined();
	await t.captures.close();
	await t.folder.close();
});

for (const landed of [true, false])
	for (const dirty of [false, true])
		test(`a delete answered Unconfirmed that ${landed ? 'landed' : 'did not land'} keeps the ${dirty ? 'dirty' : 'clean'} draft, writes nothing on its own, and waits for a choice`, async () => {
			const t = await setup();
			const stem = await t.create('Original');
			const draft = await t.open(stem);
			if (dirty) draft.inputText('Unsaved body');
			const reviewed = await t.captures.reviewDeletion(stem);
			if (!reviewed.ok) throw new Error(reviewed.message);
			t.answerNextDelete(landed ? 'landed' : 'lost');
			const exists = () => Bun.file(t.file(stem)).exists();

			expect(await t.captures.remove(reviewed.entry)).toMatchObject({
				ok: false,
				changed: false,
			});
			expect(t.captures.draft(stem)).toBe(draft);
			expect(draft.gated).toBe(false);
			expect(draft.outcome?.kind).toBe('deletion');
			expect(draft.unsettled).toBe(true);

			// A read, present or gone, confirms nothing about the delete.
			await t.captures.refresh();
			expect(t.captures.draft(stem)).toBe(draft);
			expect(draft.editor?.observation.kind).toBe(
				landed ? 'missing' : 'present',
			);
			expect(draft.outcome?.kind).toBe('deletion');
			expect(
				t.captures.rows.find((row) => row.stem === stem)?.attention,
			).toBe('deletion');
			// Typing, saving, and settling write nothing by themselves.
			await draft.save();
			expect(await t.captures.settleAll()).toBe(1);
			expect(await exists()).toBe(!landed);
			if (dirty) expect(draft.text).toBe('Unsaved body');

			if (landed && !dirty) {
				// Letting it go writes nothing and lets the draft go.
				await t.captures.discard(draft);
				expect(t.captures.draft(stem)).toBeUndefined();
				expect(await exists()).toBe(false);
				expect(await t.captures.settleAll()).toBe(0);
			} else if (landed) {
				// Saving it back is the person's choice, and writes it.
				await draft.saveMine();
				expect(await t.text(stem)).toContain('\nUnsaved body\n');
				expect(draft.outcome).toBeUndefined();
			} else {
				// Taking the file as it is answers the delete; typing then saves.
				draft.discardMine();
				expect(draft.outcome).toBeUndefined();
				expect(draft.text).toBe('Original');
				draft.inputText('After');
				await draft.save();
				expect(await t.text(stem)).toContain('\nAfter\n');
			}
			await t.captures.close({ discard: true });
			await t.folder.close();
		});

test('while a delete owns the file, nothing typed is taken, kept, or dropped', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const draft = await t.open(stem);
	const reviewed = await t.captures.reviewDeletion(stem);
	if (!reviewed.ok) throw new Error(reviewed.message);
	const release = t.holdNextDelete();
	const removing = t.captures.remove(reviewed.entry);
	await Bun.sleep(5);
	expect(draft.gated).toBe(true);

	const source = draft.source;
	draft.inputText('typed during the delete');
	draft.newThought = 'typed during the delete';
	draft.inputSource(`${source}typed during the delete\n`);
	expect(draft.addThought()).toBe(false);
	expect(draft.text).toBe('Original');
	expect(draft.textIsPending).toBe(false);
	expect(draft.newThought).toBe('');
	expect(draft.source).toBe(source);
	expect(draft.mode.kind).toBe('editing');
	expect(draft.dirty).toBe(false);
	expect(draft.refusal).toContain('being deleted');

	release();
	expect(await removing).toEqual({ ok: true });
	expect(await Bun.file(t.file(stem)).exists()).toBe(false);
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
	await draft.save();
	expect(draft.notice).toBeUndefined();
	expect(await text(stem)).toContain('Saved regardless of Git');
	expect((await captures.commit()).status).toBe('failed');
	expect(draft.notice).toBeUndefined();
	expect(captures.unsettled).toBe(0);
	expect(await text(stem)).toContain('Saved regardless of Git');
	await captures.close();
	await folder.close();
});

test('a draft whose file was removed stays open and on the timeline with its unsent input', async () => {
	const { captures, create, open, file, folder } = await setup();
	const stem = await create('Its file will go');
	const other = await create('Untouched neighbour');
	const draft = await open(stem);
	await open(other);
	// Clean source, but text typed and not added.
	draft.newThought = 'typed, not added';
	expect(draft.dirty).toBe(false);

	await rm(file(stem));
	await rm(file(other));
	await captures.refresh();

	// The neighbour had nothing to lose and is let go. This one is kept.
	expect(captures.draft(other)).toBeUndefined();
	expect(captures.draft(stem)).toBe(draft);
	expect(draft.newThought).toBe('typed, not added');
	expect(
		captures.rows.map((row) => [row.stem, row.attention, row.unsettled]),
	).toEqual([[stem, 'removed', true]]);
	expect(captures.rows[0]?.preview).toBe('Its file will go');
	expect(captures.rows[0]?.capturedAt).toBeInstanceOf(Date);
	expect(captures.unsettled).toBe(1);

	// A later listing does not drop it either.
	await captures.refresh();
	expect(captures.draft(stem)).toBe(draft);
	await captures.close();
	await folder.close();
});

test('save as a copy is refused, writing nothing, while unsent input would be dropped', async () => {
	const { captures, create, open, file, root, folder } = await setup();
	const stem = await create('Original');
	const draft = await open(stem);
	draft.inputText('My draft');
	draft.newThought = 'typed, not added';
	await rm(file(stem));
	await captures.refresh();

	const refused = await captures.saveCopy(draft);
	expect(refused.ok).toBe(false);
	if (refused.ok) return;
	expect(refused.message).toContain('not in it yet');
	expect(await readdir(join(root, 'captures'))).toEqual([]);
	expect(captures.draft(stem)).toBe(draft);
	expect(draft.newThought).toBe('typed, not added');

	// Once the thought is in the document, the copy carries everything.
	expect(draft.addThought()).toBe(true);
	const copied = await captures.saveCopy(draft);
	if (!copied.ok) throw new Error(copied.message);
	const saved = await readFile(file(copied.stem), 'utf8');
	expect(saved).toContain('My draft');
	expect(saved).toContain('- typed, not added');
	// The original is not written back by letting go of the draft.
	expect(await Bun.file(file(stem)).exists()).toBe(false);
	await captures.close();
	await folder.close();
});

test.each([
	[
		'new-thought text',
		(draft: Draft): void => {
			draft.newThought = 'typed while copying';
		},
	],
	[
		'a thought being edited',
		(draft: Draft) => {
			const [first] = draft.document.thoughts;
			if (!first) throw new Error('fixture');
			draft.startEditing(first);
			draft.inputEditing('edited while copying');
		},
	],
	[
		'refused capture text',
		(draft: Draft) => {
			draft.inputText('My draft\n```\nopen');
			if (!draft.textIsPending) throw new Error('fixture');
		},
	],
	[
		'a source edit',
		(draft: Draft) =>
			draft.inputSource(`${draft.source}- typed while copying\n`),
	],
] as const)('a copy keeps the draft that took %s while the copy was being written', async (_name, type) => {
	const t = await setup();
	const { stem, draft, mine } = await t.removedDraft();
	const release = t.holdNextCreate();
	const copying = t.captures.saveCopy(draft);
	type(draft);
	const held = {
		source: draft.source,
		newThought: draft.newThought,
		editing: draft.editing?.text,
		text: draft.text,
	};
	release();
	const copied = await copying;

	// The copy is what was submitted, and is saved.
	if (!copied.ok) throw new Error(copied.message);
	expect(await t.text(copied.stem)).toBe(mine);
	// What was typed since is in no file, so the draft is still here to leave.
	expect(t.captures.draft(stem)).toBe(draft);
	expect(draft.unsettled).toBe(true);
	expect(t.captures.unsettled).toBe(1);
	expect({
		source: draft.source,
		newThought: draft.newThought,
		editing: draft.editing?.text,
		text: draft.text,
	}).toEqual(held);
	await t.captures.close({ discard: true });
	await t.folder.close();
});

test('a copy lets go of the draft it was made from when nothing changed while it was written', async () => {
	const t = await setup();
	const { stem, draft, mine } = await t.removedDraft();
	const release = t.holdNextCreate();
	const copying = t.captures.saveCopy(draft);
	// Typed and taken back: the draft is again exactly what was submitted.
	draft.newThought = 'second thoughts';
	draft.newThought = '';
	release();
	const copied = await copying;

	if (!copied.ok) throw new Error(copied.message);
	expect(await t.text(copied.stem)).toBe(mine);
	expect(t.captures.draft(stem)).toBeUndefined();
	expect(t.captures.unsettled).toBe(0);
	expect(await Bun.file(t.file(stem)).exists()).toBe(false);
	await t.captures.close();
	await t.folder.close();
});

test('a copy that finishes late leaves a newer draft at the same path alone', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const first = await t.open(stem);
	first.inputText('My draft');
	const mine = first.source;
	const outside = (await t.text(stem)).replace('Original', 'Changed outside');
	await writeFile(t.file(stem), outside);
	await t.captures.refresh();
	expect(first.notice?.kind).toBe('changed');

	const release = t.holdNextCreate();
	const copying = t.captures.saveCopy(first);
	// The person discards the draft and opens the capture again meanwhile.
	await t.captures.discard(first);
	const second = await t.open(stem);
	if (second === first) throw new Error('fixture');
	second.newThought = 'typed in the newer draft';
	release();
	const copied = await copying;

	if (!copied.ok) throw new Error(copied.message);
	expect(await t.text(copied.stem)).toBe(mine);
	expect(t.captures.draft(stem)).toBe(second);
	expect(second.newThought).toBe('typed in the newer draft');
	expect(t.captures.unsettled).toBe(1);
	expect(await t.text(stem)).toBe(outside);
	await t.captures.close();
	await t.folder.close();
});

test('whitespace typed into the new-capture form is refused and still protected', async () => {
	const { captures, root, folder } = await setup();
	captures.newCapture = '  \n';
	expect(captures.unsettled).toBe(1);
	const created = await captures.create();
	expect(created.ok).toBe(false);
	expect(captures.newCapture).toBe('  \n');
	expect(await captures.settleAll()).toBe(1);
	expect(await readdir(join(root, 'captures')).catch(() => [])).toEqual([]);
	captures.newCapture = '';
	expect(captures.unsettled).toBe(0);
	await captures.close();
	await folder.close();
});

test('settling waits for the submitted new capture and keeps text typed during its save', async () => {
	const t = await setup();
	t.captures.newCapture = 'Submitted';
	const release = t.holdCaptureCreate();
	const creating = t.captures.create();
	const settled = t.captures.settleAll();
	t.captures.newCapture = 'Typed while saving';
	let finished = false;
	void settled.then(() => {
		finished = true;
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	release();
	const created = await creating;
	expect(created.ok).toBe(true);
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
	expect(await readFile(join(t.root, report.reportPath), 'utf8')).toContain(
		'# Capture import report',
	);
});

test('closing saves typing that arrived during a draft save before detaching', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const draft = await t.open(stem);
	draft.inputText('First');
	const saving = draft.save();
	draft.inputText('Second');
	const closing = t.captures.close().then(() => t.folder.close());
	t.captures.newCapture = 'After closing began';
	expect((await t.captures.create()).ok).toBe(false);
	await saving;
	await closing;
	expect(await t.text(stem)).toContain('\nSecond\n');
	expect(draft.dirty).toBe(false);
});

test('closing does not publish deliberately discarded input', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const draft = await t.open(stem);
	draft.inputText('Discard me');
	await t.captures.discard(draft);
	await t.captures.close();
	await t.folder.close();
	expect(await t.text(stem)).toContain('Original');
	expect(await t.text(stem)).not.toContain('Discard me');
});

test('discard and close waits for a submitted save without publishing later typing', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const draft = await t.open(stem);
	draft.inputText('Submitted');
	const saving = draft.save();
	draft.inputText('Discarded typing');
	const closing = t.captures.close({ discard: true }).then(() =>
		t.folder.close(),
	);
	await saving;
	await closing;
	expect(await t.text(stem)).toContain('\nSubmitted\n');
	expect(await t.text(stem)).not.toContain('Discarded typing');
	expect(draft.source).toContain('Discarded typing');
});

test("closing waits for a discarded draft's submitted save and drops its later typing", async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const draft = await t.open(stem);
	draft.inputText('Submitted');
	const saving = draft.save();
	draft.inputText('Discarded typing');
	const discarding = t.captures.discard(draft);
	const closing = t.captures.close().then(() => t.folder.close());
	expect(t.captures.draft(stem)).toBeUndefined();
	await Promise.all([saving, discarding, closing]);
	expect(await t.text(stem)).toContain('\nSubmitted\n');
	expect(await t.text(stem)).not.toContain('Discarded typing');
});
