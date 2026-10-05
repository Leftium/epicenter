/**
 * Departure Tests
 *
 * Drives this page's departure answer (`createDeparture`) over a stand-in for
 * the Epicenter host's side of the wire, with the real Todos owner over a real
 * browser folder on the in-memory OPFS stand-in. The host stand-in keeps the
 * wire's rules: versions rise, stale answers change nothing, `cancel` ends the
 * round. It does not run the native dialog, show or hide windows, or quit.
 *
 * Key behaviors:
 * - Listening is registered before the first status read; a round that
 *   arrives while the folder opens is answered once it has opened, and the
 *   owner is fenced as it opens
 * - Statuses apply in version order; only a newer `idle` lifts the fence
 * - A page holding nothing answers `ready` at once; a todo write still
 *   running is waited for before `ready`
 * - What cannot be saved is shown for the person's choice; a round cancelled
 *   elsewhere, or by "Keep working", gives back failed saves, newer input,
 *   and a new todo's typed title exactly as they were
 * - Leaving anyway is a `ready` vote only: nothing is discarded, and an
 *   `idle` that follows gives everything back
 * - The same round asked again re-sends `asking` without a second prompt
 * - `granted`, `leaving`, and a `discarded` vote stay fenced
 * - A page whose folder did not open answers `ready` and has nothing to lift
 * - A lost answer lifts nothing; the next read re-sends it
 * - After `destroy`, nothing is read or answered
 * - While fenced, every action, Git command, terminal command, and editor
 *   input is refused, and resuming gives them back
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createTestStorage,
	opfsOf,
	testBrowserStorage,
	testLocks,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import { todosDefinition } from './definition.js';
import type { Departure } from './departure.svelte.js';
import { createFakeHost } from './departure.test-support.js';
import { holdCloses } from './opfs-holds.test-support.js';
import type { TodosFolder } from './platform/types.js';
import type { Todos } from './todos.svelte.js';

const { createTodos } = await import('./todos.svelte.ts');
const { createDeparture } = await import('./departure.svelte.ts');
const { openTodosPage } = await import('./open-todos-page.ts');
const { DEPARTING } = await import('./todo-editor.svelte.ts');

let count = 0;
const cleanup: (() => unknown)[] = [];

afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/**
 * The real Todos owner over a fresh browser folder. `holdNextSave` holds the
 * next published write of a todo row until the returned function runs.
 */
async function openTodos(
	adapt: (folder: TodosFolder) => TodosFolder = (folder) => folder,
) {
	const storage = createTestStorage();
	let hold: PromiseWithResolvers<void> | undefined;
	let started: PromiseWithResolvers<void> | undefined;
	const folder = expectOk(
		await openFolder({
			id: `departure-test-${count++}`,
			definition: todosDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				commitOnEdit: false,
				opfs: {
					locks: testLocks,
					getDirectory: async () =>
						holdCloses(await storage.opfs.getDirectory(), async (file) => {
							const gate = hold;
							if (gate === undefined || !file.name.endsWith('.md')) return;
							hold = undefined;
							started?.resolve();
							await gate.promise;
						}),
				},
			},
		}),
	);
	const todos: Todos = createTodos(adapt(folder));
	cleanup.push(() => todos.close());
	await todos.check();
	const faults = opfsOf(storage).faults;
	return {
		todos,
		/** Hold the next todo row write; resolves once it is held. */
		holdNextSave() {
			hold = Promise.withResolvers<void>();
			started = Promise.withResolvers<void>();
			const release = hold.resolve;
			return { held: started.promise, release };
		},
		/** The next write of `path` fails before it publishes. */
		failNextWrite(path: string) {
			faults.write = (file) => {
				if (!file.endsWith(`/${path}`)) return undefined;
				faults.write = undefined;
				return 'fail';
			};
		},
		async text(path: string) {
			const read = await folder.files.read(path);
			return read.error ? undefined : new TextDecoder().decode(read.data.bytes);
		},
	};
}

function todoEditor(todos: Todos) {
	const selection = todos.selection;
	if (selection?.kind !== 'todo')
		throw new Error(`Expected an open todo, got ${selection?.kind}`);
	return selection.editor;
}

/** The identity of the prompt shown now, as its controls carry it. */
function shownPrompt(departure: Departure): number {
	const notice = departure.notice;
	if (notice?.stage !== 'choose')
		throw new Error(`Expected a prompt, got ${notice?.stage}`);
	return notice.id;
}

function track(departure: Departure) {
	cleanup.push(() => departure.destroy());
	return departure;
}

/** Let reads, answers, saves, and drains run. */
async function settle() {
	for (let i = 0; i < 20; i++) await Bun.sleep(0);
}

async function eventually(done: () => boolean) {
	for (let waited = 0; waited < 400 && !done(); waited++) await Bun.sleep(5);
}

/** A started departure with an open owner, idle. */
async function started(
	adapt?: (folder: TodosFolder) => TodosFolder,
) {
	const host = createFakeHost();
	const departure = track(createDeparture(host.port));
	await departure.start();
	const opened = await openTodos(adapt);
	departure.attach(opened.todos);
	return { host, departure, ...opened };
}

/** A gate a wrapped folder call waits on until the test opens it. */
function gate() {
	let held = Promise.withResolvers<void>();
	return {
		calls: 0,
		/** Resolves once a call is waiting. */
		entered: Promise.withResolvers<void>(),
		async wait() {
			this.calls += 1;
			this.entered.resolve();
			await held.promise;
		},
		open() {
			held.resolve();
			held = Promise.withResolvers<void>();
		},
	};
}

/**
 * The folder with its Git fetch held at `fetch`, and its fast-forward and
 * merge counted, so a test sees which steps of a pull or merge ran.
 */
function heldGit(fetch: ReturnType<typeof gate>) {
	const applied = { pullFastForward: 0, mergeIncoming: 0 };
	const adapt = (folder: TodosFolder): TodosFolder => ({
		...folder,
		git: {
			...folder.git,
			get snapshot() {
				return folder.git.snapshot;
			},
			get mergeUnsupported() {
				return undefined;
			},
			async fetch() {
				await fetch.wait();
				return Ok({ status: 'fetched', oid: undefined });
			},
			async pullFastForward() {
				applied.pullFastForward += 1;
				return folder.git.pullFastForward();
			},
			async mergeIncoming() {
				applied.mergeIncoming += 1;
				return folder.git.mergeIncoming();
			},
		},
	});
	return { adapt, applied };
}

/** The folder with each terminal command held at `exec` before it runs. */
function heldTerminal(exec: ReturnType<typeof gate>) {
	return (folder: TodosFolder): TodosFolder => ({
		...folder,
		terminal(options) {
			const shell = folder.terminal(options);
			return {
				get cwd() {
					return shell.cwd;
				},
				async exec(command, execOptions) {
					await exec.wait();
					return shell.exec(command, execOptions);
				},
			};
		},
	});
}

test('listening is registered before the first status read, and a round that arrives while the folder opens is answered once the owner has opened, fenced', async () => {
	const host = createFakeHost();
	const release = host.holdListening();
	const departure = track(createDeparture(host.port));
	const starting = departure.start();
	await settle();
	expect(host.calls).toEqual(['listen']);
	release();
	await starting;
	expect(host.calls).toEqual(['listen', 'listening', 'status']);

	// A quit begins while the folder is still opening: nothing is answered yet.
	host.begin('quit');
	host.nudge();
	await settle();
	expect(host.answers).toEqual([]);
	expect(departure.notice).toEqual({ stage: 'saving', intent: 'quit' });

	const { todos } = await openTodos();
	departure.attach(todos);
	// Fenced as it opens, before anything is awaited.
	expect(todos.departing).toBe(true);
	await settle();
	// It holds nothing, so it answers ready, and stays fenced.
	expect(host.answers.map((answer) => answer.answer)).toEqual(['ready']);
	expect(host.status).toMatchObject({ phase: 'collecting', vote: 'ready' });
	expect(todos.departing).toBe(true);

	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(todos.departing).toBe(false);
	expect(departure.notice).toBeUndefined();
});

/**
 * A folder opener for `openTodosPage` that counts its calls and can be held,
 * so a test sees whether, and when, the page opened anything.
 */
function folderOpener() {
	let gate: Promise<void> | undefined;
	const opener = {
		calls: 0,
		/** Hold the next open until the returned function runs. */
		hold() {
			const held = Promise.withResolvers<void>();
			gate = held.promise;
			return held.resolve;
		},
		open: async () => {
			opener.calls += 1;
			const opened = await openFolder({
				id: `departure-open-${count++}`,
				definition: todosDefinition,
				browser: { commitOnEdit: false, ...testBrowserStorage() },
			});
			await gate;
			return opened;
		},
	};
	return opener;
}

/** Open the page as `+page.svelte` does, keeping the owner for cleanup. */
function openPage(departure: Departure, opener: ReturnType<typeof folderOpener>) {
	const opening = openTodosPage(departure, opener.open).then((opened) => {
		if (opened.data !== null) cleanup.push(() => opened.data.close());
		return opened;
	});
	// A page that leaves first rejects; the test checks that itself.
	opening.catch(() => {});
	return opening;
}

test('a listener that could not register leaves the page unopened; Retry registers once and opens it', async () => {
	const host = createFakeHost();
	host.refuseListening(1);
	const departure = track(createDeparture(host.port));
	const opener = folderOpener();
	const opening = openPage(departure, opener);
	await expect(departure.start()).rejects.toThrow('could not listen');
	await settle();
	expect(opener.calls).toBe(0);
	expect(host.calls).toEqual(['listen']);

	await departure.start();
	const todos = expectOk(await opening);
	expect(opener.calls).toBe(1);
	expect(host.calls).toEqual(['listen', 'listen', 'listening', 'status']);
	expect(todos.departing).toBe(false);
	// One listener: a nudge reads once.
	host.nudge();
	await settle();
	expect(host.calls.filter((call) => call === 'status')).toHaveLength(2);
});

test('a first status read that failed or was malformed is not idle: nothing opens until a read succeeds, and Retry does not listen again', async () => {
	const host = createFakeHost();
	host.faultStatus('reject', 'malformed');
	const departure = track(createDeparture(host.port));
	const opener = folderOpener();
	const opening = openPage(departure, opener);
	await expect(departure.start()).rejects.toThrow('status read failed');
	await settle();
	expect(opener.calls).toBe(0);
	await expect(departure.start()).rejects.toThrow();
	await settle();
	expect(opener.calls).toBe(0);

	await departure.start();
	expectOk(await opening);
	expect(opener.calls).toBe(1);
	expect(host.calls.filter((call) => call === 'listen')).toHaveLength(1);
	expect(host.calls.filter((call) => call === 'status')).toHaveLength(3);
});

test('after a failed first read, a nudge for a running round opens the page fenced, and it answers for the owner', async () => {
	const host = createFakeHost();
	host.faultStatus('reject');
	const departure = track(createDeparture(host.port));
	const opener = folderOpener();
	const opening = openPage(departure, opener);
	await expect(departure.start()).rejects.toThrow();
	expect(opener.calls).toBe(0);

	host.begin('quit');
	host.nudge();
	const todos = expectOk(await opening);
	// Fenced from the moment it was attached; it never took input.
	expect(todos.departing).toBe(true);
	todos.newTitle = 'Typed';
	expect(todos.newTitle).toBe('');
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual(['ready']);
});

test('after a failed first read, a focus gain reads again and opens the page', async () => {
	const host = createFakeHost();
	host.faultStatus('reject');
	const departure = track(createDeparture(host.port));
	const opener = folderOpener();
	const opening = openPage(departure, opener);
	await expect(departure.start()).rejects.toThrow();
	await settle();
	expect(opener.calls).toBe(0);
	host.focus();
	const todos = expectOk(await opening);
	expect(todos.departing).toBe(false);
});

test('a round that begins while the folder opens fences the owner as it is attached, before anything else', async () => {
	const host = createFakeHost();
	const departure = track(createDeparture(host.port));
	const opener = folderOpener();
	const release = opener.hold();
	const opening = openPage(departure, opener);
	await departure.start();
	await eventually(() => opener.calls === 1);
	host.begin('restart');
	host.nudge();
	await settle();
	expect(host.answers).toEqual([]);
	release();
	const todos = expectOk(await opening);
	expect(todos.departing).toBe(true);
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual(['ready']);
});

test('a page that leaves during a failed startup opens nothing and answers nothing', async () => {
	const host = createFakeHost();
	host.faultStatus('reject');
	const departure = track(createDeparture(host.port));
	const opener = folderOpener();
	const opening = openPage(departure, opener);
	await expect(departure.start()).rejects.toThrow();
	departure.destroy();
	await expect(opening).rejects.toThrow('left');
	expect(host.calls.at(-1)).toBe('unlisten');
	host.begin('quit');
	host.nudge();
	host.focus();
	await settle();
	expect(opener.calls).toBe(0);
	expect(host.answers).toEqual([]);
	await expect(departure.start()).rejects.toThrow('left');
});

test('statuses apply in version order: an older idle read after a newer round lifts nothing, and a newer idle does', async () => {
	const { host, todos } = await started();
	host.begin();
	const round = host.status.version;
	host.nudge();
	await settle();
	expect(todos.departing).toBe(true);

	// A read that answers with an older version: ignored.
	host.set({ phase: 'idle' }, round - 1);
	host.nudge();
	await settle();
	expect(todos.departing).toBe(true);

	host.set({ phase: 'idle' }, round + 10);
	host.nudge();
	await settle();
	expect(todos.departing).toBe(false);
});

test('a todo write still running is waited for before the page answers ready', async () => {
	const { host, departure, todos, text } = await started();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const editor = todoEditor(todos);
	editor.setTitle('Oat milk');
	expect(editor.isSaving).toBe(true);
	host.begin('restart');
	host.nudge();
	await eventually(() => host.answers.length >= 2);
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'ready',
	]);
	expect(await text(path)).toContain('"Oat milk"');
	expect(host.status).toMatchObject({ phase: 'collecting', vote: 'ready' });
	expect(departure.notice).toEqual({ stage: 'ready', intent: 'restart' });
	expect(todos.departing).toBe(true);
	expect(editor.isIdle).toBe(true);
});

test('a round cancelled elsewhere gives back a failed save and the newer input typed after it, as they were', async () => {
	const { host, departure, todos, failNextWrite, text } = await started();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const saved = await text(path);
	const editor = todoEditor(todos);
	failNextWrite(path);
	editor.setTitle('First');
	await editor.editor.waitForSaves();
	expect(editor.editor.save.status).toBe('failed');
	failNextWrite(path);
	editor.setTitle('Newer');
	await editor.editor.waitForSaves();

	host.begin('quit');
	host.nudge();
	await eventually(() => departure.notice?.stage === 'choose');
	expect(departure.notice).toEqual({
		stage: 'choose',
		id: expect.any(Number),
		intent: 'quit',
		paths: [path],
		newTitle: false,
	});
	expect(host.answers.map((answer) => answer.answer)).toEqual(['asking']);
	// Nothing was retried for the failed save.
	expect(await text(path)).toBe(saved);

	// Another window's "Keep working" ends the round.
	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(todos.departing).toBe(false);
	expect(departure.notice).toBeUndefined();
	expect(editor.editor.save.status).toBe('failed');
	expect(editor.title()).toBe('Newer');
	expect(await text(path)).toBe(saved);
});

test('leaving anyway is a ready vote only: the failed save and its input stay fenced until idle gives them back', async () => {
	const { host, departure, todos, failNextWrite, text } = await started();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const saved = await text(path);
	const editor = todoEditor(todos);
	failNextWrite(path);
	editor.setTitle('Mine');
	await eventually(() => editor.editor.save.status === 'failed');

	host.begin('quit');
	host.nudge();
	await eventually(() => departure.notice?.stage === 'choose');
	departure.leaveAnyway(shownPrompt(departure));
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'ready',
	]);
	expect(departure.notice).toEqual({ stage: 'ready', intent: 'quit' });
	expect(todos.departing).toBe(true);
	expect(editor.editor.save.status).toBe('failed');
	expect(editor.title()).toBe('Mine');
	// Still fenced while the other window decides.
	editor.setNotes('ignored\n');
	expect(editor.notes()).toBe('');

	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(todos.departing).toBe(false);
	expect(editor.editor.save.status).toBe('failed');
	expect(editor.title()).toBe('Mine');
	expect(await text(path)).toBe(saved);
});

test('the same round asked again while the drain hangs re-sends asking, with no second prompt', async () => {
	const { host, departure, todos, holdNextSave, text } = await started();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const editor = todoEditor(todos);
	const { held, release } = holdNextSave();
	editor.setTitle('Slow');
	host.begin('quit');
	host.nudge();
	await held;
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual(['asking']);
	expect(departure.notice?.stage).toBe('saving');

	// The person quits again: the host shows the round with no vote.
	host.set({ phase: 'collecting', vote: 'none' });
	host.nudge();
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'asking',
	]);
	expect(departure.notice?.stage).toBe('saving');

	release();
	await eventually(() => host.answers.length >= 3);
	expect(host.answers.at(-1)?.answer).toBe('ready');
	expect(await text(path)).toContain('"Slow"');
});

test('a newer round that arrives while the person chooses is handled from the start, fenced throughout', async () => {
	const { host, departure, todos } = await started();
	todos.newTitle = 'Buy milk';
	host.begin('quit');
	host.nudge();
	await eventually(() => departure.notice?.stage === 'choose');
	const first = host.status;
	expect(first.phase === 'idle' ? undefined : first.round).toBe(1);

	// The round ends and a restart round begins before this page reads idle.
	host.begin('restart');
	host.nudge();
	await eventually(
		() =>
			departure.notice?.stage === 'choose' &&
			departure.notice.intent === 'restart',
	);
	expect(todos.departing).toBe(true);
	expect(host.answers.map((answer) => [answer.round, answer.answer])).toEqual([
		[1, 'asking'],
		[2, 'asking'],
	]);
	// The person's choice answers the newer round only.
	departure.keepWorking(shownPrompt(departure));
	await settle();
	expect(host.answers.at(-1)).toMatchObject({ round: 2, answer: 'cancel' });
	expect(todos.departing).toBe(false);
	expect(todos.newTitle).toBe('Buy milk');
});

test('granted, leaving, and a discarded vote stay fenced: nothing is edited or started', async () => {
	for (const next of [
		{ phase: 'granted' },
		{ phase: 'leaving' },
		{ phase: 'collecting', vote: 'discarded' },
	] as const) {
		const { host, departure, todos } = await started();
		await todos.create('Milk');
		const editor = todoEditor(todos);
		host.begin('quit');
		host.set(next);
		host.nudge();
		await settle();
		expect(todos.departing).toBe(true);
		expect(departure.notice).toEqual({ stage: 'leaving', intent: 'quit' });
		editor.setTitle('Late');
		expect(editor.title()).toBe('Milk');
		expect(await todos.create('Another')).toBe(DEPARTING);
		todos.newTitle = 'Typed';
		expect(todos.newTitle).toBe('');
		// Focus while fenced reads again; still fenced.
		host.focus();
		await settle();
		expect(todos.departing).toBe(true);
	}
});

test('a page whose folder did not open answers ready, and an idle that follows has nothing to give back', async () => {
	const host = createFakeHost();
	const departure = track(createDeparture(host.port));
	await departure.start();
	departure.attach(undefined);
	host.begin('restart');
	host.nudge();
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual(['ready']);
	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(departure.notice).toBeUndefined();
	// A later round is answered the same way.
	host.begin('quit');
	host.nudge();
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'ready',
		'ready',
	]);
});

test('a lost answer lifts nothing, and the next read re-sends it', async () => {
	const { host, todos } = await started();
	host.loseAnswers(1);
	host.begin('quit');
	host.nudge();
	await settle();
	// The ready answer was lost; the page read again and sent it again.
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'ready',
		'ready',
	]);
	expect(host.status).toMatchObject({ phase: 'collecting', vote: 'ready' });
	expect(todos.departing).toBe(true);
});

test('a new todo title typed and not added counts: the page asks, and Keep working cancels the round and gives it back', async () => {
	const { host, departure, todos } = await started();
	todos.newTitle = 'Buy milk';
	host.begin('quit');
	host.nudge();
	await eventually(() => departure.notice?.stage === 'choose');
	expect(departure.notice).toEqual({
		stage: 'choose',
		id: expect.any(Number),
		intent: 'quit',
		paths: [],
		newTitle: true,
	});
	departure.keepWorking(shownPrompt(departure));
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'cancel',
	]);
	expect(host.status.phase).toBe('idle');
	expect(todos.departing).toBe(false);
	expect(todos.newTitle).toBe('Buy milk');
	// Nothing was created from it.
	expect(todos.entries).toEqual([]);
});

test('after destroy, nudges read nothing and nothing is answered', async () => {
	const { host, departure } = await started();
	departure.destroy();
	expect(host.calls.at(-1)).toBe('unlisten');
	const reads = host.calls.length;
	host.begin('quit');
	host.nudge();
	await settle();
	expect(host.calls.length).toBe(reads);
	expect(host.answers).toEqual([]);
});

test('while fenced, every action, Git command, terminal command, and editor input is refused; resuming gives them back', async () => {
	const { todos, text } = await openTodos();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const editor = todoEditor(todos);
	expectOk(await todos.folder.files.create('notes.txt', 'saved'));
	await todos.open('notes.txt');
	const selection = todos.selection;
	if (selection?.kind !== 'file' || selection.file.kind !== 'text')
		throw new Error('Expected the notes text editor');
	const notes = selection.file.editor;
	const saved = await text(path);
	const entry = todos.entries[0]!;

	todos.prepareDeparture();
	// Editors refuse input and commands.
	editor.setTitle('Late');
	editor.setNotes('late\n');
	expect(editor.title()).toBe('Milk');
	expect(editor.notes()).toBe('');
	expect(editor.retry()).toBe(DEPARTING);
	expect(await editor.toggle(true)).toBe(DEPARTING);
	expect(editor.editSource()).toBe(DEPARTING);
	expect(editor.isFenced).toBe(true);
	notes.input('typed');
	expect(notes.buffer).toBe('saved');
	expect(notes.isFenced).toBe(true);
	// Actions refuse.
	todos.newTitle = 'Typed';
	expect(todos.newTitle).toBe('');
	expect(await todos.create('New')).toBe(DEPARTING);
	expect(await todos.toggle(entry)).toBe(DEPARTING);
	expect(await todos.rename(path, 'oat.md')).toBe(DEPARTING);
	expect(expectErr(await todos.deletionFor(path))).toBe(DEPARTING);
	expect(
		await todos.remove({ kind: 'file', path: 'notes.txt', sha256: 'x' }),
	).toBe(DEPARTING);
	expect(await todos.createFile('', 'more.txt')).toBe(DEPARTING);
	expect(await todos.createFolder('', 'docs')).toBe(DEPARTING);
	expect(await todos.reload(path)).toBe(DEPARTING);
	todos.discard('notes.txt');
	await todos.open(path);
	expect(todoEditor(todos)).toBe(editor);
	// Git and the terminal refuse.
	expect(await todos.commitAndPush()).toEqual({
		commit: { status: 'blocked', reason: DEPARTING },
		push: { status: 'skipped', reason: DEPARTING },
	});
	expect(expectErr(await todos.pull()).message).toContain(DEPARTING);
	expect(expectErr(await todos.merge()).message).toContain(DEPARTING);
	expect(expectErr(await todos.fetch()).message).toContain(DEPARTING);
	expect(await todos.recoverIncoming()).toEqual({ kind: 'busy' });
	// The terminal takes no typing and Enter runs nothing.
	todos.terminal.command = 'touch shell.txt';
	expect(todos.terminal.command).toBe('');
	await todos.terminal.run();
	expect(todos.terminal.runs).toEqual([]);
	expect(await text('shell.txt')).toBeUndefined();
	// Longer than a plain editor's typing batch.
	await Bun.sleep(450);
	expect(await text(path)).toBe(saved);
	expect(todos.entries).toHaveLength(1);

	todos.resumeDeparture();
	expect(todos.departing).toBe(false);
	editor.setTitle('After');
	notes.input('after');
	await eventually(() => editor.isIdle && notes.isIdle);
	expect(await text(path)).toContain('"After"');
	expect(await text('notes.txt')).toBe('after');
});

// ============================================================================
// Registration, prompt identity, admitted operations, the terminal, and
// lagging votes
// ============================================================================

test('a nudge during a listener registration that then fails reads nothing and opens nothing; Retry recovers', async () => {
	const host = createFakeHost();
	const releaseFocus = host.holdFocusRegistration();
	host.refuseListening(1);
	const departure = track(createDeparture(host.port));
	const opener = folderOpener();
	const opening = openPage(departure, opener);
	const starting = departure.start();
	await settle();
	// The change listener is registered; focus registration is not done.
	host.begin('quit');
	host.nudge();
	await settle();
	expect(host.calls).toEqual(['listen']);
	releaseFocus();
	await expect(starting).rejects.toThrow('could not listen');
	host.nudge();
	await settle();
	expect(host.calls.filter((call) => call === 'status')).toEqual([]);
	expect(opener.calls).toBe(0);

	await departure.start();
	const todos = expectOk(await opening);
	expect(opener.calls).toBe(1);
	expect(todos.departing).toBe(true);
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual(['ready']);
});

test('a nudge during a registration that then succeeds reads nothing itself; the read after registering covers it', async () => {
	const host = createFakeHost();
	const releaseFocus = host.holdFocusRegistration();
	const departure = track(createDeparture(host.port));
	const starting = departure.start();
	await settle();
	host.nudge();
	await settle();
	expect(host.calls).toEqual(['listen']);
	releaseFocus();
	await starting;
	expect(host.calls).toEqual(['listen', 'listening', 'status']);
});

test("a choice from an earlier round's prompt answers nothing in a later round", async () => {
	const { host, departure, todos } = await started();
	todos.newTitle = 'Buy milk';
	host.begin('quit');
	host.nudge();
	await eventually(() => departure.notice?.stage === 'choose');
	const first = shownPrompt(departure);
	// Another window ends the quit; a restart begins.
	host.set({ phase: 'idle' });
	host.begin('restart');
	host.nudge();
	await eventually(
		() =>
			departure.notice?.stage === 'choose' &&
			departure.notice.intent === 'restart',
	);
	expect(shownPrompt(departure)).not.toBe(first);
	departure.leaveAnyway(first);
	departure.keepWorking(first);
	await settle();
	expect(host.answers.map((answer) => [answer.round, answer.answer])).toEqual([
		[1, 'asking'],
		[2, 'asking'],
	]);
	expect(departure.notice?.stage).toBe('choose');
	expect(todos.departing).toBe(true);
});

for (const ending of [
	{ phase: 'granted' },
	{ phase: 'collecting', vote: 'discarded' },
] as const)
	test(`${ending.phase === 'granted' ? 'granted' : 'a discarded vote'} during a held drain ends the handling: the drain finishes, and nothing more is answered or prompted`, async () => {
		const { host, departure, todos, holdNextSave, text } = await started();
		await todos.create('Milk');
		const path = todos.selectedPath!;
		todoEditor(todos).setTitle('Slow');
		todos.newTitle = 'Buy milk';
		const { held, release } = holdNextSave();
		host.begin('quit');
		host.nudge();
		await held;
		await settle();
		expect(host.answers.map((answer) => answer.answer)).toEqual(['asking']);

		host.set(ending);
		host.nudge();
		await settle();
		expect(departure.notice).toEqual({ stage: 'leaving', intent: 'quit' });
		release();
		await eventually(() => !todos.saving);
		await settle();
		// The admitted save landed; no ready, no prompt, and still fenced.
		expect(await text(path)).toContain('"Slow"');
		expect(host.answers.map((answer) => answer.answer)).toEqual(['asking']);
		expect(departure.notice).toEqual({ stage: 'leaving', intent: 'quit' });
		expect(todos.departing).toBe(true);
	});

test('a ready answer lost before the host recorded it, with asking recorded, is sent again on the next read', async () => {
	const { host, todos, holdNextSave } = await started();
	await todos.create('Milk');
	todoEditor(todos).setTitle('Slow');
	const { held, release } = holdNextSave();
	host.begin('quit');
	host.nudge();
	await held;
	await settle();
	expect(host.status).toMatchObject({ phase: 'collecting', vote: 'asking' });
	host.loseAnswers(1);
	release();
	await eventually(() => host.answers.length >= 3);
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'ready',
		'ready',
	]);
	expect(host.status).toMatchObject({ phase: 'collecting', vote: 'ready' });
	// A repeated Quit for the same round re-sends ready, not asking.
	host.set({ phase: 'collecting', vote: 'none' });
	host.nudge();
	await settle();
	expect(host.answers.at(-1)?.answer).toBe('ready');
	expect(todos.departing).toBe(true);
});

test('Keep working whose answer was lost is sent again, and a repeated Quit does not turn it back into asking', async () => {
	const { host, departure, todos } = await started();
	todos.newTitle = 'Buy milk';
	host.begin('quit');
	host.nudge();
	await eventually(() => departure.notice?.stage === 'choose');
	host.loseAnswers(1);
	departure.keepWorking(shownPrompt(departure));
	await settle();
	// Lost, then read again with asking still recorded: cancel again.
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'cancel',
		'cancel',
	]);
	expect(host.status.phase).toBe('idle');
	expect(todos.departing).toBe(false);
	expect(todos.newTitle).toBe('Buy milk');
});

test('answers that keep failing while reads succeed stop after one recovery read, and each nudge or focus tries again once', async () => {
	const { host, todos } = await started();
	host.loseAnswers(1000);
	host.begin('quit');
	host.nudge();
	await settle();
	await Bun.sleep(30);
	await settle();
	// The answer, then one recovery read and its resend; then nothing.
	expect(host.answers.map((answer) => answer.answer)).toEqual(['ready', 'ready']);
	const reads = host.calls.filter((call) => call === 'status').length;
	await Bun.sleep(30);
	await settle();
	expect(host.answers).toHaveLength(2);
	expect(host.calls.filter((call) => call === 'status').length).toBe(reads);
	expect(todos.departing).toBe(true);

	// The host's nudge reads and resends; lost, it recovers once more.
	host.nudge();
	await settle();
	expect(host.answers).toHaveLength(4);
	// Focus while fenced does the same.
	host.focus();
	await settle();
	expect(host.answers).toHaveLength(6);

	// Answers reach the host again: the next nudge settles the vote.
	host.loseAnswers(0);
	host.nudge();
	await settle();
	expect(host.answers).toHaveLength(7);
	expect(host.status).toMatchObject({ phase: 'collecting', vote: 'ready' });
	host.nudge();
	await settle();
	expect(host.answers).toHaveLength(7);
	expect(todos.departing).toBe(true);
});

test('a granted round re-sends nothing, whatever reads follow', async () => {
	const { host, todos } = await started();
	host.begin('quit');
	host.nudge();
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual(['ready']);
	host.set({ phase: 'granted', vote: 'none' });
	host.nudge();
	host.focus();
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual(['ready']);
	expect(todos.departing).toBe(true);
});

test('a pull admitted before a departure is waited for, and its apply step is withdrawn and says so', async () => {
	const fetch = gate();
	const { adapt, applied } = heldGit(fetch);
	const { host, departure, todos } = await started(adapt);
	const pulling = todos.pull();
	await fetch.entered.promise;
	host.begin('quit');
	host.nudge();
	await settle();
	// The pull is still running: the page asks and waits for it.
	expect(host.answers.map((answer) => answer.answer)).toEqual(['asking']);
	expect(departure.notice?.stage).toBe('saving');

	fetch.open();
	expect(expectErr(await pulling).message).toContain('nothing was applied');
	expect(applied.pullFastForward).toBe(0);
	await eventually(() => host.answers.length >= 2);
	expect(host.answers.at(-1)?.answer).toBe('ready');
});

test('a merge admitted before a departure is withdrawn after its fetch, and close waits for a running pull through its last step', async () => {
	const fetch = gate();
	const { adapt, applied } = heldGit(fetch);
	const { host, todos } = await started(adapt);
	const merging = todos.merge();
	await fetch.entered.promise;
	host.begin('restart');
	host.nudge();
	await settle();
	fetch.open();
	expect(expectErr(await merging).message).toContain('nothing was applied');
	expect(applied.mergeIncoming).toBe(0);
	await eventually(() => host.answers.length >= 2);
	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(todos.departing).toBe(false);

	fetch.entered = Promise.withResolvers();
	const pulling = todos.pull();
	await fetch.entered.promise;
	let closed = false;
	const closing = todos.close().then(() => {
		closed = true;
	});
	await settle();
	expect(closed).toBe(false);
	fetch.open();
	// A fetch that answers after close began applies nothing; close waited
	// for the whole pull before it closed the folder.
	expect(expectErr(await pulling).name).toBe('Closed');
	await closing;
	expect(closed).toBe(true);
	expect(applied.pullFastForward).toBe(0);
});

test('a terminal command admitted before a departure is waited for; meanwhile the session keeps its command, history, and output, and Enter does nothing', async () => {
	const exec = gate();
	const { host, todos, text } = await started(heldTerminal(exec));
	const { terminal } = todos;
	terminal.command = 'echo first > first.txt';
	const running = terminal.run();
	await exec.entered.promise;
	host.begin('quit');
	host.nudge();
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual(['asking']);
	exec.open();
	await running;
	await eventually(() => host.answers.length >= 2);
	expect(host.answers.at(-1)?.answer).toBe('ready');
	expect(await text('first.txt')).toBe('first\n');

	// Fenced: typing, recall, and Enter change nothing.
	const runs = terminal.runs.length;
	terminal.command = 'echo second > second.txt';
	expect(terminal.command).toBe('');
	expect(terminal.recall('previous')).toBe(false);
	expect(terminal.isFenced).toBe(true);
	await terminal.run();
	expect(terminal.runs.length).toBe(runs);
	expect(exec.calls).toBe(1);

	// The quit is cancelled elsewhere: the terminal takes typing again.
	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(terminal.isFenced).toBe(false);
	terminal.command = 'echo kept';
	expect(terminal.command).toBe('echo kept');
	expect(terminal.recall('previous')).toBe(true);
	expect(terminal.command).toBe('echo first > first.txt');
});

test('a command typed in the terminal before a departure stays exactly as typed through a cancelled round, and is not counted as unsaved', async () => {
	const { host, todos } = await started();
	const { terminal } = todos;
	terminal.command = 'git status';
	host.begin('quit');
	host.nudge();
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual(['ready']);
	await terminal.run();
	expect(terminal.command).toBe('git status');
	expect(terminal.runs).toEqual([]);
	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(terminal.command).toBe('git status');
});
