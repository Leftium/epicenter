/**
 * Folder edits over a real directory folder (EXPERIMENT)
 *
 * Binds `createFolderEdits` to `@epicenter/folder/bun` over a fresh temporary
 * directory, with saves passing through the same manual gates the demo
 * server uses. The other writer is `node:fs`, outside the folder handle.
 * This is where the Bun folder's real ordering matters: its change hint runs
 * inside the save, before the reply.
 *
 * Key behaviors:
 * - the own write read during a held reply is not a change from elsewhere
 * - another writer at the publication moment is a conflict, resolved against the reviewed file
 * - structured changes keep undeclared keys and comments
 * - a candidate that does not parse refuses structured changes and saves as text
 * - a lost reply stays unknown; the file afterward is observed as usual
 * - a removed file and bytes that are not UTF-8 are different observations
 * - a lone surrogate is drafted as the text a save writes
 * - a handle stays bound to its row or file
 * - a one-shot save patches the displayed source once and writes nothing on refusal
 * - app autosave waits out a running save, pauses on a bad outcome, and
 *   resumes only by request and after review
 */
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { openFolder } from '../../src/bun.js';
import { patchSource } from '../../src/markdown.js';
import { createFolderEdits } from './folder-edits.js';
import { createPublicationGates } from './gates.js';
import { definition, FORM_STEM, SEED } from './todos.js';
import { type AutosavePause, createAutosave } from './web/autosave.js';

Object.assign(process.env, {
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_TERMINAL_PROMPT: '0',
});

const PLAN = `todos/${FORM_STEM}.md`;

async function setup() {
	const root = await mkdtemp(
		join(await realpath(tmpdir()), 'epicenter-edit-handle-test-'),
	);
	const folder = expectOk(
		await openFolder({
			root,
			definition,
			git: {
				author: { name: 'Test', email: 'test@example.test' },
				commitOnEdit: false,
			},
		}),
	);
	expectOk(await folder.files.create(PLAN, SEED[PLAN] ?? ''));
	let published = 0;
	const gates = createPublicationGates((event) => {
		if (event.kind === 'published') published += 1;
	});
	const todos = folder.tables.todos;
	const edits = createFolderEdits({
		tables: {
			todos: {
				inspect: todos.inspect,
				get: todos.get,
				replace: (capture, source) =>
					gates.run(
						capture.path,
						() => todos.replace(capture, source),
						(receipt) => receipt.sha256,
					),
			},
		},
		files: folder.files,
		onFilesChanged: folder.onFilesChanged,
	});
	const displayed = expectOk(await todos.get(FORM_STEM));
	if (displayed === undefined) throw new Error('seeded row is missing');
	const edit = edits.tables.todos.edit(displayed);
	await edit.refresh();
	const file = join(root, PLAN);
	return {
		folder,
		edits,
		edit,
		gates,
		root,
		/** How many saves the folder published, whatever their replies said. */
		published: () => published,
		/** The other writer: patch the file on disk with `node:fs`. */
		async writeElsewhere(fields: Record<string, unknown>) {
			const text = await readFile(file, 'utf8');
			await writeFile(file, expectOk(patchSource(text, { fields })));
		},
		disk: () => readFile(file, 'utf8'),
		file,
		async [Symbol.asyncDispose]() {
			edit.dispose();
			await folder.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

test('the own write read during a held reply is not a change from elsewhere, and typing then stays unsaved', async () => {
	await using demo = await setup();
	const { edit, gates } = demo;
	expect(edit.change({ fields: { title: 'B' } }).error).toBeNull();
	gates.arm('afterPublication');
	const saving = edit.save();
	await gates.whenHeld();

	// The Bun folder hinted inside the save; read now, before the reply.
	await edit.refresh();
	expect(edit.get().saving?.seenOnDisk).toBe(true);
	expect(edit.get().incoming).toBeUndefined();
	expect(edit.change({ body: 'Typed during the save.\n' }).error).toBeNull();

	gates.release();
	const outcome = await saving;
	expect(outcome.kind).toBe('saved');
	await edit.refresh();
	expect(edit.get().incoming).toBeUndefined();
	expect(edit.get().baseline.fields.title).toBe('B');
	expect(edit.get().isDirty).toBe(true);
	expect(edit.get().reading.body).toBe('Typed during the save.\n');
	expect(await demo.disk()).toBe(edit.get().baseline.source);
});

test('another writer at the publication moment conflicts; keeping the draft over the reviewed file saves it with unknown keys intact', async () => {
	await using demo = await setup();
	const { edit, gates } = demo;
	edit.change({ fields: { done: true } });
	gates.arm('beforePublication');
	const saving = edit.save();
	await gates.whenHeld();
	await demo.writeElsewhere({ title: 'Changed elsewhere' });
	gates.release();

	expect((await saving).kind).toBe('conflict');
	await edit.refresh();
	const incoming = edit.get().incoming;
	if (incoming?.kind !== 'present') throw new Error('expected incoming file');
	expect(incoming.snapshot.fields.title).toBe('Changed elsewhere');
	expect(edit.get().reading.fields.done).toBe(true);

	// Bring the other writer's title into the draft, then save over what was reviewed.
	edit.change({ fields: { title: incoming.snapshot.fields.title } });
	expect(edit.keepDraft(incoming.snapshot).error).toBeNull();
	expect((await edit.save()).kind).toBe('saved');

	const saved = await demo.disk();
	expect(saved).toContain('title: Changed elsewhere');
	expect(saved).toContain('done: true');
	expect(saved).toContain(
		'owner: sam # not declared by the table; kept as written',
	);
	expect(saved).toContain('# Seeded by the edit-handle demo.');
});

test('a candidate that does not parse refuses structured changes, stays intact, and saves as complete text', async () => {
	await using demo = await setup();
	const { edit } = demo;
	const broken = 'title: no fences\n';
	edit.input(broken);
	expect(edit.get().reading.parseError).toBeDefined();

	const refused = edit.change({ fields: { done: true } });
	expect(refused.error).toMatchObject({ kind: 'unparsed' });
	expect(edit.get().source).toBe(broken);

	expect((await edit.save()).kind).toBe('saved');
	expect(await demo.disk()).toBe(broken);

	edit.input(`---\n${broken}---\n`);
	expect(edit.get().reading.parseError).toBeUndefined();
	expect(edit.change({ fields: { done: true } }).error).toBeNull();
});

test('a lost reply stays unknown; the file holding the draft afterward is an ordinary observation', async () => {
	await using demo = await setup();
	const { edit, gates } = demo;
	edit.change({ fields: { title: 'Maybe saved' } });
	const submitted = edit.get().source;
	gates.arm('loseReply');

	// The harness published, then discarded the reply.
	const outcome = await edit.save();
	expect(outcome.kind === 'unconfirmed' && outcome.attempt.source).toBe(
		submitted,
	);

	await edit.refresh();
	expect(edit.get().lastSave?.kind).toBe('unconfirmed');
	expect(edit.get().baseline.source).toBe(submitted);
	expect(edit.get().isDirty).toBe(false);
});

test('a removed file and bytes that are not UTF-8 are different observations', async () => {
	await using demo = await setup();
	const { edit } = demo;
	await rm(demo.file);
	await edit.refresh();
	expect(edit.get().incoming).toEqual({ kind: 'missing' });

	await writeFile(demo.file, new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff]));
	await edit.refresh();
	const incoming = edit.get().incoming;
	expect(incoming?.kind === 'unreadable' && incoming.error.name).toBe(
		'InvalidUtf8',
	);
	expect(edit.get().source).toBe(SEED[PLAN] ?? '');
});

test('a lone surrogate is drafted as the text a save writes: clean after saving, seen while held, matched on disk after a lost reply', async () => {
	await using demo = await setup();
	const { edit, gates } = demo;
	edit.change({ body: 'Lone \uD800 surrogate.\n' });
	expect(edit.get().source).toContain('Lone � surrogate.');

	gates.arm('afterPublication');
	const saving = edit.save();
	await gates.whenHeld();
	await edit.refresh();
	expect(edit.get().saving?.seenOnDisk).toBe(true);
	gates.release();
	expect((await saving).kind).toBe('saved');
	expect(edit.get().isDirty).toBe(false);

	edit.input(`${edit.get().source}Another \uDC00.\n`);
	const submitted = edit.get().source;
	expect(submitted).toContain('Another �.');
	gates.arm('loseReply');
	expect((await edit.save()).kind).toBe('unconfirmed');
	await edit.refresh();
	expect(edit.get().lastSave?.kind).toBe('unconfirmed');
	expect(edit.get().baseline.source).toBe(submitted);
	expect(edit.get().isDirty).toBe(false);
	expect(await demo.disk()).toBe(submitted);
});

test('a handle stays bound to its row or file: another row or file is refused and its file is never written', async () => {
	await using demo = await setup();
	const { folder, edits, edit } = demo;
	const MILK = 'todos/milk.md';
	expectOk(await folder.files.create(MILK, SEED[MILK] ?? ''));
	const milk = expectOk(await folder.tables.todos.get('milk'));
	if (milk === undefined) throw new Error('milk is missing');

	expect(() =>
		edits.tables.todos.edit({ ...milk, path: edit.get().path }),
	).toThrow(TypeError);
	edit.change({ fields: { done: true } });
	expect(edit.keepDraft(milk).error).toEqual({
		kind: 'refused',
		reason: 'otherPath',
	});
	expect(edit.takeObserved(milk).error).toEqual({
		kind: 'refused',
		reason: 'otherPath',
	});
	expect((await edit.save()).kind).toBe('saved');
	expect(await readFile(join(demo.root, MILK), 'utf8')).toBe(SEED[MILK] ?? '');

	const notes = expectOk(await folder.files.create('notes.txt', 'notes\n'));
	const other = expectOk(await folder.files.create('other.txt', 'other\n'));
	const text = edits.files.edit({ ...notes, source: 'notes\n' });
	expect(text.takeObserved({ ...other, source: 'other\n' }).error).toEqual({
		kind: 'refused',
		reason: 'otherPath',
	});
	expect(text.get().baseline.path).toBe('notes.txt');
	await text.dispose();
});

test('a one-shot save patches the displayed source once, and a stale or unsafe source writes nothing', async () => {
	await using demo = await setup();
	const { folder, edits } = demo;
	const displayed = expectOk(await folder.tables.todos.get(FORM_STEM));
	if (displayed === undefined) throw new Error('plan is missing');

	const saved = expectOk(
		await edits.tables.todos.save(displayed, { fields: { done: true } }),
	);
	expect(saved.fields.done).toBe(true);
	expect(await demo.disk()).toBe(saved.source);
	expect(saved.source).toContain('owner: sam # not declared by the table');

	// The snapshot that was displayed is stale now: no write, no retry.
	const stale = await edits.tables.todos.save(displayed, {
		fields: { done: false },
	});
	expect(stale.error?.name).toBe('Conflict');
	expect(await demo.disk()).toBe(saved.source);

	// A value with a tag parses, but the patch refuses to change it.
	await writeFile(demo.file, '---\ntitle: Tagged\ndone: !!bool false\n---\n');
	const tagged = expectOk(await folder.tables.todos.get(FORM_STEM));
	if (tagged === undefined) throw new Error('plan is missing');
	expect(tagged.parseError).toBeUndefined();
	const unsafe = await edits.tables.todos.save(tagged, {
		fields: { done: true },
	});
	expect(unsafe.error?.name).toBe('UnsupportedSource');
	expect(await demo.disk()).toBe(tagged.source);
});

// ============================================================================
// App autosave: real timers (20 ms delay), manual gates
// ============================================================================

/** Long enough for several autosave delays to pass. */
const SEVERAL_DELAYS = 80;

/** Resolve with the first state, current or later, that satisfies `predicate`. */
function until<TState>(
	edit: { subscribe(listener: (state: TState) => void): () => void },
	predicate: (state: TState) => boolean,
): Promise<TState> {
	return new Promise((resolve) => {
		let settled = false;
		const stop = edit.subscribe((state) => {
			if (settled || !predicate(state)) return;
			settled = true;
			queueMicrotask(() => stop());
			resolve(state);
		});
	});
}

test('autosave: typing during a held save starts nothing; once B lands, C saves once against B', async () => {
	await using demo = await setup();
	const { edit, gates } = demo;
	const against: string[] = [];
	const receipts: string[] = [];
	edit.subscribe((state) => {
		const target = state.saving?.against.sha256;
		if (target !== undefined && against.at(-1) !== target) against.push(target);
		if (state.lastSave?.kind === 'saved') {
			const sha256 = state.lastSave.receipt.sha256;
			if (receipts.at(-1) !== sha256) receipts.push(sha256);
		}
	});
	const autosave = createAutosave(edit, { delayMs: 20 });
	autosave.start();

	gates.arm('afterPublication');
	edit.change({ fields: { title: 'B' } });
	await gates.whenHeld();
	edit.change({ fields: { title: 'C' } });
	await Bun.sleep(SEVERAL_DELAYS);
	expect(demo.published()).toBe(1);

	gates.release();
	const saved = await until(
		edit,
		(state) =>
			state.lastSave?.kind === 'saved' && state.baseline.fields.title === 'C',
	);
	expect(saved.isDirty).toBe(false);
	expect(against).toHaveLength(2);
	expect(against[1]).toBe(receipts[0]);
	await Bun.sleep(SEVERAL_DELAYS);
	expect(demo.published()).toBe(2);
	autosave.stop();
});

test('autosave pauses on a conflict; typing and rereads do not retry, and resume waits for review, then saves once', async () => {
	await using demo = await setup();
	const { edit, gates } = demo;
	let paused: AutosavePause | undefined;
	const autosave = createAutosave(edit, {
		delayMs: 20,
		onPauseChange: (reason) => {
			paused = reason;
		},
	});
	autosave.start();

	gates.arm('beforePublication');
	edit.change({ fields: { done: true } });
	await gates.whenHeld();
	await demo.writeElsewhere({ title: 'Changed elsewhere' });
	gates.release();
	await until(edit, (state) => state.lastSave?.kind === 'conflict');
	expect(paused).toBe('conflict');

	edit.change({ fields: { priority: 'high' } });
	await edit.refresh();
	await Bun.sleep(SEVERAL_DELAYS);
	expect(paused).toBe('conflict');
	expect(demo.published()).toBe(0);

	// Resumed, but the incoming file has not been reviewed: still nothing.
	autosave.resume();
	await Bun.sleep(SEVERAL_DELAYS);
	expect(demo.published()).toBe(0);

	const incoming = edit.get().incoming;
	if (incoming?.kind !== 'present') throw new Error('expected incoming file');
	expect(edit.keepDraft(incoming.snapshot).error).toBeNull();
	const saved = await until(edit, (state) => state.lastSave?.kind === 'saved');
	await Bun.sleep(SEVERAL_DELAYS);
	expect(demo.published()).toBe(1);
	expect(await demo.disk()).toBe(saved.baseline.source);
	expect(saved.baseline.fields).toMatchObject({ done: true, priority: 'high' });
	autosave.stop();
});

test('autosave pauses on an unknown outcome, and once stopped arms no timer and writes nothing', async () => {
	await using demo = await setup();
	const { edit, gates } = demo;
	let paused: AutosavePause | undefined;
	const autosave = createAutosave(edit, {
		delayMs: 20,
		onPauseChange: (reason) => {
			paused = reason;
		},
	});
	autosave.start();

	gates.arm('loseReply');
	edit.change({ fields: { title: 'B' } });
	await until(edit, (state) => state.lastSave?.kind === 'unconfirmed');
	expect(paused).toBe('unconfirmed');
	expect(demo.published()).toBe(1);

	edit.change({ fields: { title: 'C' } });
	await edit.refresh();
	await Bun.sleep(SEVERAL_DELAYS);
	expect(demo.published()).toBe(1);

	autosave.stop();
	autosave.resume();
	edit.change({ fields: { title: 'D' } });
	await Bun.sleep(SEVERAL_DELAYS);
	expect(demo.published()).toBe(1);
	expect(paused).toBeUndefined();
});
