/**
 * Captures Collection Tests
 *
 * Runs the real collection and draft modules over a real native folder in a
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
 * - Deleting removes exactly the reviewed file, and refuses one that changed
 * - A save still reaches the file when Git cannot commit
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
import type { CommitOutcome } from '@epicenter/app/files';
import { openNativeFolder } from '@epicenter/app/files/native';
import { captureDefinition } from '@epicenter/capture';

const { createCaptures } = await import('./captures.svelte.ts');

const roots: string[] = [];
afterAll(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function setup(options: { commit?: () => Promise<CommitOutcome> } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'capture-app-'));
	roots.push(root);
	const folder = await openNativeFolder({
		root,
		definition: captureDefinition,
		git: {
			author: { name: 'Test', email: 'test@localhost' },
			commitOnEdit: false,
		},
	});
	const captures = createCaptures(
		{
			folder: {
				tables: folder.tables,
				files: folder.files,
				git: {
					get snapshot() {
						return folder.git.snapshot;
					},
					subscribe: folder.git.subscribe,
					commit: options.commit ?? folder.git.commit,
				},
			},
			location: { kind: 'directory', path: root },
		},
		{ batchMs: 60_000 },
	);
	const file = (stem: string) => join(root, 'captures', `${stem}.md`);
	return {
		root,
		folder,
		captures,
		file,
		text: (stem: string) => readFile(file(stem), 'utf8'),
		async create(text: string) {
			captures.newCapture = text;
			const created = await captures.create();
			if (!created.ok) throw new Error(created.message);
			return created.stem;
		},
	};
}

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
	captures.close();
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
	captures.close();
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
	captures.close();
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
	captures.close();
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
	captures.close();
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
	captures.close();
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
	captures.close();
	await folder.close();
});

test('a save reaches the file when the commit fails', async () => {
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
	expect(await text(stem)).toContain('Saved regardless of Git');
	captures.close();
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
	captures.close();
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
	captures.close();
	await folder.close();
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
	captures.close();
	await folder.close();
});
