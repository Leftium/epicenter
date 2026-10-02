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
 * - An outside edit refreshes a clean draft and conflicts a dirty one
 * - A removed file and an unreadable file are reported differently
 * - Save as a copy writes the draft at a new path and never touches the
 *   original
 * - A draft written back to its removed file is acknowledged as exactly what
 *   was written; what another program does to the file next is a separate
 *   observation, and is never overwritten without a choice
 * - A copy lets go of the draft only when the copy holds all of it: input
 *   typed while the copy was being written keeps the draft
 * - A capture whose filename breaks the naming rules, or is empty, is opened,
 *   reread, written back, and deleted at its literal stem
 * - Deleting removes exactly the reviewed file, and refuses one that changed
 * - An explicit commit failure leaves saved files and drafts unchanged
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
import { type CommitOutcome, hashBytes } from '@epicenter/folder';
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
	let heldReplace: Promise<void> | undefined;
	const captures = createCaptures(
		{
			folder: {
				tables: {
					captures: {
						...folder.tables.captures,
						async create(options) {
							const held = heldCreate;
							heldCreate = undefined;
							await held;
							return folder.tables.captures.create(options);
						},
						async replace(entry, source) {
							const held = heldReplace;
							heldReplace = undefined;
							await held;
							return folder.tables.captures.replace(entry, source);
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
	return {
		root,
		folder,
		captures,
		file,
		text: (stem: string) => readFile(file(stem), 'utf8'),
		create,
		holdCaptureCreate() {
			let release!: () => void;
			heldCreate = new Promise<void>((resolve) => {
				release = resolve;
			});
			return release;
		},
		holdDraftSave() {
			let release!: () => void;
			heldReplace = new Promise<void>((resolve) => {
				release = resolve;
			});
			return release;
		},
		/** Run `work` once the next exact create has been published. */
		afterNextCreate(work: () => Promise<unknown>) {
			nextCreate.afterCreate = work;
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
			const draft = captures.open(stem);
			if (!draft) throw new Error('no draft');
			draft.inputText('My draft');
			draft.newThought = 'a thought';
			if (!draft.addThought()) throw new Error('fixture');
			await rm(file(stem));
			await captures.refresh();
			const state = draft.saveState;
			if (state.kind !== 'conflict' || state.current.kind !== 'removed')
				throw new Error('fixture');
			return { stem, draft, mine: draft.buffer };
		},
	};
}

const versionOf = (source: string) =>
	hashBytes(new TextEncoder().encode(source));

test('creating writes exact Markdown; listing and opening write nothing', async () => {
	const { captures, create, text, file, folder } = await setup();
	const stem = await create('Dinner with Sebastian\nFriday at seven');
	const saved = await text(stem);
	expect(saved).toMatch(
		/^---\ncapturedAt: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n---\n\nDinner with Sebastian\nFriday at seven\n\n## Thoughts\n$/,
	);
	expect(captures.newCapture).toBe('');

	const before = (await Bun.file(file(stem)).stat()).mtimeMs;
	await captures.refresh();
	const draft = captures.open(stem);
	expect(draft?.document.text).toBe('Dinner with Sebastian\nFriday at seven');
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
	expect(captures.rows.at(-1)?.capturedAt).toBeUndefined();
	expect(captures.rows.at(-1)?.problem).toContain('datetime');
	await captures.close();
	await folder.close();
});

test('structured edits save as the expected file and reload as the same thoughts', async () => {
	const { captures, create, text, folder } = await setup();
	const stem = await create('Idea');
	const draft = captures.open(stem);
	if (!draft) throw new Error('no draft');
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

	const head = (await text(stem)).split('\n\n')[0];
	expect(await text(stem)).toBe(
		`${head}\n\nIdea\n\n## Thoughts\n\n- three\n- two\n  with a second line\n`,
	);
	expect(draft.unsettled).toBe(false);
	await captures.close();
	await folder.close();
});

test('an outside edit refreshes a clean draft and conflicts a dirty one', async () => {
	const { captures, create, text, file, folder } = await setup();
	const stem = await create('Original');
	const draft = captures.open(stem);
	if (!draft) throw new Error('no draft');
	const original = await text(stem);

	const outside = original.replace('Original', 'Edited in another program');
	await writeFile(file(stem), outside);
	await captures.refresh();
	expect(draft.buffer).toBe(outside);
	expect(draft.saveState.kind).toBe('saved');
	expect(await text(stem)).toBe(outside);

	draft.inputText('My unsaved typing');
	const mine = draft.buffer;
	const again = outside.replace('Edited in another program', 'Edited again');
	await writeFile(file(stem), again);
	await captures.refresh();
	expect(draft.buffer).toBe(mine);
	const state = draft.saveState;
	expect(
		state.kind === 'conflict' &&
			state.current.kind === 'present' &&
			state.current.entry.source,
	).toBe(again);
	expect(await text(stem)).toBe(again);
	expect(captures.unsettled).toBe(1);

	await draft.saveMine();
	expect(await text(stem)).toBe(mine);
	expect(captures.unsettled).toBe(0);
	await captures.close();
	await folder.close();
});

test('removed and unreadable files are told apart, and a copy keeps the draft', async () => {
	const { captures, create, text, file, root, folder } = await setup();
	const removedStem = await create('Will be removed');
	const brokenStem = await create('Will be unreadable');
	const removed = captures.open(removedStem);
	const broken = captures.open(brokenStem);
	if (!removed || !broken) throw new Error('no draft');
	removed.inputText('Typed before the file went away');
	broken.inputText('Typed before the file broke');

	await rm(file(removedStem));
	await writeFile(file(brokenStem), new Uint8Array([0xff, 0xfe, 0x00]));
	await captures.refresh();

	const gone = removed.saveState;
	expect(gone.kind === 'conflict' && gone.current.kind).toBe('removed');
	const unreadable = broken.saveState;
	expect(unreadable.kind === 'conflict' && unreadable.current.kind).toBe(
		'unreadable',
	);
	expect(captures.unreadable.map((item) => item.path)).toEqual([
		`captures/${brokenStem}.md`,
	]);

	// The unreadable file cannot be overwritten; a copy saves the draft beside it.
	await broken.saveMine();
	expect(new Uint8Array(await readFile(file(brokenStem)))).toEqual(
		new Uint8Array([0xff, 0xfe, 0x00]),
	);
	const copy = await captures.saveCopy(broken);
	if (!copy.ok) throw new Error(copy.message);
	expect(await text(copy.stem)).toContain('Typed before the file broke');
	expect(captures.draft(brokenStem)).toBeUndefined();

	// The removed file can be written back at its own path.
	await removed.saveMine();
	expect(await text(removedStem)).toContain('Typed before the file went away');
	expect(removed.saveState.kind).toBe('saved');
	expect((await readdir(join(root, 'captures'))).sort()).toEqual(
		[`${removedStem}.md`, `${brokenStem}.md`, `${copy.stem}.md`].sort(),
	);
	await captures.close();
	await folder.close();
});

for (const stem of ['bad ', ''])
	test(`a capture at the literal stem ${JSON.stringify(stem)} shows its filename problem, and its draft rereads, keeps its typing, and writes back at that file`, async () => {
		const { captures, create, text, file, folder } = await setup();
		// Valid source, saved by another program under a name creation refuses.
		const source = await text(await create('Original'));
		await writeFile(file(stem), source);
		await captures.refresh();
		const row = captures.rows.find(
			(item) => item.path === `captures/${stem}.md`,
		);
		expect(row?.stem).toBe(stem);
		expect(row?.problem).toContain('the stem');

		const draft = captures.open(stem);
		if (!draft) throw new Error('no draft');
		draft.inputText('My typing');
		const mine = draft.buffer;
		const outside = source.replace('Original', 'Edited outside');
		await writeFile(file(stem), outside);
		// No listing ran: the refused save rereads this file by its stem.
		await draft.save();
		const changed = draft.saveState;
		expect(
			changed.kind === 'conflict' &&
				changed.current.kind === 'present' &&
				changed.current.entry,
		).toMatchObject({ stem, source: outside });
		expect(draft.buffer).toBe(mine);
		expect(await text(stem)).toBe(outside);

		// Removed outside, the draft is written back at the same file.
		await rm(file(stem));
		await captures.refresh();
		const gone = draft.saveState;
		expect(gone.kind === 'conflict' && gone.current.kind).toBe('removed');
		await draft.saveMine();
		expect(draft.saveState.kind).toBe('saved');
		expect(draft.baseline.stem).toBe(stem);
		expect(await text(stem)).toBe(mine);

		const reviewed = await captures.reviewDeletion(stem);
		if (!reviewed.ok) throw new Error(reviewed.message);
		expect(await captures.remove(reviewed.entry)).toEqual({ ok: true });
		expect(await Bun.file(file(stem)).exists()).toBe(false);
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

test('a failed explicit commit keeps the saved file and its draft acknowledged', async () => {
	const { captures, create, text, folder } = await setup({
		commit: async () => ({ status: 'failed', error: 'index is locked' }),
	});
	const stem = await create('Saved regardless');
	const draft = captures.open(stem);
	if (!draft) throw new Error('no draft');
	draft.inputText('Saved regardless of Git');
	await draft.save();
	expect(draft.saveState.kind).toBe('saved');
	expect(await text(stem)).toContain('Saved regardless of Git');
	expect((await captures.commit()).status).toBe('failed');
	expect(draft.saveState.kind).toBe('saved');
	expect(captures.unsettled).toBe(0);
	expect(await text(stem)).toContain('Saved regardless of Git');
	await captures.close();
	await folder.close();
});

test('a draft whose file was removed stays open and on the timeline with its unsent input', async () => {
	const { captures, create, file, folder } = await setup();
	const stem = await create('Its file will go');
	const other = await create('Untouched neighbour');
	const draft = captures.open(stem);
	captures.open(other);
	if (!draft) throw new Error('no draft');
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
		captures.rows.map((row) => [row.stem, row.conflict, row.unsettled]),
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
	const { captures, create, file, root, folder } = await setup();
	const stem = await create('Original');
	const draft = captures.open(stem);
	if (!draft) throw new Error('no draft');
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

	// Once the thought is in the source, the copy carries everything.
	expect(draft.addThought()).toBe(true);
	const copied = await captures.saveCopy(draft);
	if (!copied.ok) throw new Error(copied.message);
	const saved = await readFile(file(copied.stem), 'utf8');
	expect(saved).toContain('My draft');
	expect(saved).toContain('- typed, not added');
	await captures.close();
	await folder.close();
});

test('a draft written back, then replaced by another program before it is read back, is not saved over the replacement', async () => {
	const { captures, removedDraft, afterNextCreate, text, file, folder } =
		await setup();
	const { stem, draft, mine } = await removedDraft();
	const outside = mine.replace('My draft', 'Saved by another program');
	afterNextCreate(() => writeFile(file(stem), outside));
	await draft.saveMine();

	// Mine was written and is no longer typing; the file now is shown instead.
	expect(draft.saveState.kind).toBe('saved');
	expect(draft.baseline.source).toBe(outside);
	expect(draft.buffer).toBe(outside);
	expect(draft.dirty).toBe(false);
	await draft.save();
	expect(await captures.settleAll()).toBe(0);
	expect(await text(stem)).toBe(outside);
	await captures.close();
	await folder.close();
});

test('typing during a write back stays against what was written when another program replaces the file', async () => {
	const t = await setup();
	const { stem, draft, mine } = await t.removedDraft();
	const outside = mine.replace('My draft', 'Saved by another program');
	const release = t.holdNextCreate();
	t.afterNextCreate(() => writeFile(t.file(stem), outside));
	const writing = draft.saveMine();
	draft.inputText('My draft, and more');
	const typed = draft.buffer;
	release();
	await writing;

	expect(draft.baseline.source).toBe(mine);
	expect(draft.baseline.sha256).toEqual(await versionOf(mine));
	expect(draft.buffer).toBe(typed);
	const state = draft.saveState;
	expect(
		state.kind === 'conflict' &&
			state.current.kind === 'present' &&
			state.current.entry.source,
	).toBe(outside);

	// Saving is paused until a choice is made: the replacement is not overwritten.
	await draft.save();
	expect(await t.captures.settleAll()).toBe(1);
	expect(await t.text(stem)).toBe(outside);
	await t.captures.close();
	await t.folder.close();
});

test.each([
	['removed', (path: string) => rm(path)],
	[
		'unreadable',
		(path: string) => writeFile(path, new Uint8Array([0xff, 0xfe, 0x00])),
	],
] as const)('a write back that landed is not a failed save when the file is %s straight after', async (kind, outside) => {
	const t = await setup();
	const { stem, draft, mine } = await t.removedDraft();
	const release = t.holdNextCreate();
	t.afterNextCreate(() => outside(t.file(stem)));
	const writing = draft.saveMine();
	draft.inputText('My draft, and more');
	const typed = draft.buffer;
	release();
	await writing;

	// What was written is the baseline; what became of the file is a conflict.
	expect(draft.baseline.source).toBe(mine);
	expect(draft.baseline.sha256).toEqual(await versionOf(mine));
	expect(draft.buffer).toBe(typed);
	const state = draft.saveState;
	expect(state.kind === 'conflict' && state.current.kind).toBe(kind);
	expect(t.captures.draft(stem)).toBe(draft);
	expect(t.captures.unsettled).toBe(1);
	await t.captures.close();
	await t.folder.close();
});

test('a write back that landed and was then removed lets go of a draft with nothing more typed', async () => {
	const t = await setup();
	const { stem, draft, mine } = await t.removedDraft();
	t.afterNextCreate(() => rm(t.file(stem)));
	await draft.saveMine();

	expect(draft.saveState.kind).toBe('saved');
	expect(draft.baseline.source).toBe(mine);
	expect(draft.baseline.sha256).toEqual(await versionOf(mine));
	expect(draft.gone).toBe(true);
	expect(t.captures.unsettled).toBe(0);
	await t.captures.close();
	await t.folder.close();
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
			draft.inputSource(`${draft.buffer}- typed while copying\n`),
	],
] as const)('a copy keeps the draft that took %s while the copy was being written', async (_name, type) => {
	const t = await setup();
	const { stem, draft, mine } = await t.removedDraft();
	const release = t.holdNextCreate();
	const copying = t.captures.saveCopy(draft);
	type(draft);
	const held = {
		buffer: draft.buffer,
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
		buffer: draft.buffer,
		newThought: draft.newThought,
		editing: draft.editing?.text,
		text: draft.text,
	}).toEqual(held);
	await t.captures.refresh();
	expect(t.captures.draft(stem)).toBe(draft);
	expect(
		t.captures.rows.map((row) => [row.stem, row.unsettled]).sort(),
	).toEqual(
		[
			[copied.stem, false],
			[stem, true],
		].sort(),
	);
	await t.captures.close();
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
	await t.captures.close();
	await t.folder.close();
});

test('a copy that finishes late leaves a newer draft at the same path alone', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const first = t.captures.open(stem);
	if (!first) throw new Error('no draft');
	first.inputText('My draft');
	const mine = first.buffer;
	const outside = (await t.text(stem)).replace('Original', 'Changed outside');
	await writeFile(t.file(stem), outside);
	await t.captures.refresh();
	expect(first.saveState.kind).toBe('conflict');

	const release = t.holdNextCreate();
	const copying = t.captures.saveCopy(first);
	// The person discards the draft and opens the capture again meanwhile.
	t.captures.discard(first);
	await t.captures.refresh();
	const second = t.captures.open(stem);
	if (!second || second === first) throw new Error('fixture');
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

test('closing drains typing that arrived during a draft save before detaching', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const draft = t.captures.open(stem);
	if (!draft) throw new Error('missing draft');
	draft.inputText('First');
	const release = t.holdDraftSave();
	const saving = draft.save();
	draft.inputText('Second');
	const closing = t.captures.close().then(() => t.folder.close());
	t.captures.newCapture = 'After closing began';
	expect((await t.captures.create()).ok).toBe(false);
	release();
	await saving;
	await closing;
	expect(await t.text(stem)).toContain('Second');
	expect(draft.dirty).toBe(false);
});

test('closing does not publish deliberately discarded input', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const draft = t.captures.open(stem);
	if (!draft) throw new Error('missing draft');
	draft.inputText('Discard me');
	t.captures.discard(draft);
	await t.captures.close();
	await t.folder.close();
	expect(await t.text(stem)).toContain('Original');
	expect(await t.text(stem)).not.toContain('Discard me');
});

test('discard and close waits for a submitted save without publishing later typing', async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const draft = t.captures.open(stem);
	if (!draft) throw new Error('missing draft');
	draft.inputText('Submitted');
	const release = t.holdDraftSave();
	const saving = draft.save();
	draft.inputText('Discarded typing');
	let closed = false;
	const closing = t.captures.close({ discard: true }).then(async () => {
		await t.folder.close();
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	release();
	await saving;
	await closing;
	expect(await t.text(stem)).toContain('Submitted');
	expect(await t.text(stem)).not.toContain('Discarded typing');
	expect(draft.buffer).toContain('Discarded typing');
});

test("closing waits for a discarded draft's submitted save and drops its later typing", async () => {
	const t = await setup();
	const stem = await t.create('Original');
	const draft = t.captures.open(stem);
	if (!draft) throw new Error('missing draft');
	draft.inputText('Submitted');
	const release = t.holdDraftSave();
	const saving = draft.save();
	draft.inputText('Discarded typing');
	const discarding = t.captures.discard(draft);
	const closing = t.captures.close().then(() => t.folder.close());
	expect(t.captures.draft(stem)).toBeUndefined();
	release();
	await Promise.all([saving, discarding, closing]);
	expect(await t.text(stem)).toContain('Submitted');
	expect(await t.text(stem)).not.toContain('Discarded typing');
});
