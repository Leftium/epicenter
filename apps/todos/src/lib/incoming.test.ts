/**
 * Incoming Update Tests
 *
 * Drives the real Todos state module against a production browser folder
 * whose remote is the demo's real Git target: a bare repository served by
 * `git http-backend`, and an ordinary native checkout that commits and pushes
 * with system Git. The folder runs on the in-memory OPFS stand-in, so a pull
 * can be interrupted at one file write, leaving what a closed tab would.
 *
 * Key behaviors:
 * - A pull of changed remote content lands byte for byte, frontmatter the
 *   app does not declare and comments included; an open todo shows it once
 *   reloaded, and a later save keeps the undeclared keys
 * - An interrupted pull is reported and never resumed: status, refreshes,
 *   and reopening only read it. Commits, pulls, and merges wait; editing,
 *   saving, and fetching continue
 * - Recovery runs only when asked. A path in neither state is named, nothing
 *   is written, and the update stays pending until the person makes the file
 *   hold one of its versions; then recovery finishes and the open todo shows
 *   the result
 * - Recovery waits for open edits: a failed save stops it before anything
 *   runs, and open todos refuse typing while it runs, then read what the
 *   update wrote. A file still opening when recovery starts installs its
 *   editor first and is held with the rest
 * - Each open todo is fenced before recovery waits for the next one, so
 *   input that failed is kept and never reloaded away
 */
import './svelte-modules.test-support.js';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectRow, openFolder } from '@epicenter/folder/browser';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
	opfsOf,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import {
	createGitHandler,
	type GitSession,
	prepareGitSession,
} from '../../server/git-server.js';
import { todosDefinition } from './definition.js';
import type { TodosFolder } from './platform/types.js';
import { incomingLine, recoveryLine } from './status.js';
import type { TodoEditor } from './todo-editor.svelte.js';
import type { Todos } from './todos.svelte.js';

const { createTodos } = await import('./todos.svelte.ts');

const originalFetch = globalThis.fetch;
const env = {
	...process.env,
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'Native',
	GIT_AUTHOR_EMAIL: 'native@localhost',
	GIT_COMMITTER_NAME: 'Native',
	GIT_COMMITTER_EMAIL: 'native@localhost',
};

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = '/dev/null';
	delete process.env.TODOS_DEMO_ROOT;
});
afterAll(() => {
	globalThis.fetch = originalFetch;
});

const opened: Todos[] = [];
afterEach(async () => {
	for (const todos of opened.splice(0)) await todos.close();
});

let count = 0;
const MILK = 'todos/milk.md';
const BREAD = 'todos/bread.md';
const EGGS = 'todos/eggs.md';
/** The row as another computer rewrote it: a comment, and keys Todos does not declare. */
const MILK_REMOTE = `---
# Edited on another computer
title: Buy oat milk
done: true
owner: sam
labels: [home, weekly]
---
Two cartons.
`;
const BREAD_REMOTE = '---\ntitle: Bake bread\ndone: false\n---\n';

async function run(cwd: string, command: string[]) {
	const child = Bun.spawn(command, {
		cwd,
		env,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`${command.join(' ')}: ${stderr}${stdout}`);
	return stdout.trim();
}

/**
 * A browser folder whose remote is a fresh demo session, opened by the app.
 * `adapt` wraps the folder the app sees. The returned `opfs` is the folder's
 * stand-in storage, where a test injects a fault.
 */
async function openDemo(
	adapt: (folder: TodosFolder) => TodosFolder = (f) => f,
) {
	const session = await prepareGitSession(5990);
	const handle = await createGitHandler(session);
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		handle(new Request(input, init))) as typeof fetch;
	const storage = createTestStorage();
	const id = `incoming-${count++}`;
	const openTodos = async () => {
		const folder = expectOk(
			await openFolder({
				id,
				definition: todosDefinition,
				browser: {
					author: { name: 'Todos', email: 'todos@localhost' },
					remote: { url: session.remoteUrl, branch: 'main' },
					commitOnEdit: false,
					...browserStorage(storage),
				},
			}),
		);
		const todos = createTodos(adapt(folder));
		opened.push(todos);
		await todos.check();
		return todos;
	};
	return {
		session,
		opfs: opfsOf(storage),
		openTodos,
		todos: await openTodos(),
	};
}

/** The app creates and pushes a milk todo; the native checkout pulls it. */
async function shareMilk(todos: Todos, session: GitSession) {
	expectOk(
		await todos.folder.tables.todos.create({
			stem: 'milk',
			fields: { title: 'Buy milk', done: false },
		}),
	);
	await todos.refresh();
	const pushed = await todos.commitAndPush();
	expect(pushed.push.status).toBe('pushed');
	await run(session.nativeCheckout, [
		'git',
		'pull',
		'--quiet',
		'--ff-only',
		session.bare,
		'main',
	]);
}

/** The native checkout rewrites milk, adds bread, commits, and pushes. */
async function pushRemoteChanges(session: GitSession) {
	const native = session.nativeCheckout;
	await writeFile(join(native, MILK), MILK_REMOTE);
	await writeFile(join(native, BREAD), BREAD_REMOTE);
	await run(native, ['git', 'add', '-A']);
	await run(native, ['git', 'commit', '--quiet', '-m', 'Edit elsewhere']);
	await run(native, ['git', 'push', '--quiet', session.bare, 'main']);
}

async function text(todos: Todos, path: string) {
	const read = await todos.folder.files.read(path);
	return read.error ? undefined : new TextDecoder().decode(read.data.bytes);
}

function todoEditor(todos: Todos) {
	const item = todos.current?.item;
	if (item?.kind !== 'todo')
		throw new Error(`Expected an open todo, got ${item?.kind}`);
	return item.editor;
}

/** Wait for a todo's admitted writes. Answers why the latest did not land. */
async function written(editor: TodoEditor) {
	await editor.settle();
	return editor.save.status === 'failed'
		? editor.save.error.message
		: undefined;
}

/** The fields view's current row; it shows only for a valid row. */
function fieldsOf(editor: TodoEditor) {
	const { row } = editor;
	if (row.status !== 'valid') throw new Error('The row shows no fields');
	return row;
}

/** What the notes control sends: the complete row on screen with `notes`. */
function typeNotes(editor: TodoEditor, notes: string) {
	const row = fieldsOf(editor);
	return editor.set({ ...row, body: notes });
}

/**
 * A pull interrupted at the write of `todos/milk.md`: bread may have landed,
 * milk did not, and the update is pending.
 */
async function interruptedPull(adapt?: (folder: TodosFolder) => TodosFolder) {
	const demo = await openDemo(adapt);
	const { todos, session, opfs } = demo;
	await shareMilk(todos, session);
	const before = (await text(todos, MILK))!;
	await pushRemoteChanges(session);
	let failed = false;
	opfs.faults.write = (path) => {
		if (failed || !path.endsWith(`/${MILK}`)) return undefined;
		failed = true;
		return 'fail';
	};
	const pulled = await todos.pull();
	opfs.faults.write = undefined;
	return { ...demo, before, pulled };
}

test('a pull of remote changes keeps undeclared frontmatter byte for byte, an open todo shows it once reloaded, and a save keeps the undeclared keys', async () => {
	const { todos, session } = await openDemo();
	await shareMilk(todos, session);
	await todos.open(MILK, 'todos');
	const editor = todoEditor(todos);
	expect(fieldsOf(editor).fields.title).toBe('Buy milk');
	await pushRemoteChanges(session);

	const pulled = expectOk(await todos.pull());
	expect(pulled).toMatchObject({ status: 'fastForwarded' });
	expect(await text(todos, MILK)).toBe(MILK_REMOTE);
	expect(await text(todos, BREAD)).toBe(BREAD_REMOTE);
	expect(
		todos.entries.map((entry) => [entry.path, entry.fields.title]).sort(),
	).toEqual([
		[BREAD, 'Bake bread'],
		[MILK, 'Buy oat milk'],
	]);

	// The open todo still shows what it loaded until the person reloads it.
	expect(fieldsOf(editor).fields.title).toBe('Buy milk');
	expect(await todos.reload(MILK)).toBeUndefined();
	expect(editor.row).toMatchObject({
		status: 'valid',
		text: MILK_REMOTE,
		fields: {
			title: 'Buy oat milk',
			done: true,
			owner: 'sam',
			labels: ['home', 'weekly'],
		},
		body: 'Two cartons.\n',
	});
	expect(editor.isIdle).toBe(true);
	expect(await text(todos, MILK)).toBe(MILK_REMOTE);

	// A save writes the standard form, and the undeclared keys stay.
	typeNotes(editor, 'Three cartons.\n');
	expect(await written(editor)).toBeUndefined();
	const saved = (await text(todos, MILK))!;
	expect(saved).toContain('"owner": "sam"');
	expect(saved).toContain('"labels"');
	expect(saved).toContain('"weekly"');
	expect(saved).toContain('Three cartons.');
	expect(incomingLine(todos.git)).toBeUndefined();
}, 60_000);

test('the remote-edit demo fixture pushes a hand edit that Pull brings in byte for byte', async () => {
	const { todos, session } = await openDemo();
	await shareMilk(todos, session);
	// The fixture pushes to the checkout's origin; here that is the bare path.
	await run(session.nativeCheckout, [
		'git',
		'remote',
		'set-url',
		'origin',
		session.bare,
	]);
	const pushed = JSON.parse(
		await run(join(import.meta.dir, '../..'), [
			'bun',
			'scripts/remote-edit.ts',
			session.nativeCheckout,
			'milk',
			'Buy oat milk',
		]),
	);
	expect(pushed.path).toBe(MILK);
	expect(pushed.source).toContain('owner: sam');

	expect(expectOk(await todos.pull())).toMatchObject({
		status: 'fastForwarded',
		changedPaths: [MILK],
	});
	expect(await text(todos, MILK)).toBe(pushed.source);
	expect(todos.entries[0]?.fields).toEqual({
		title: 'Buy oat milk',
		done: true,
	});
}, 60_000);

test('an interrupted pull is reported and never resumed: history waits, editing and fetch continue, and reopening only reads it', async () => {
	const { todos, opfs, before, pulled, openTodos } = await interruptedPull();
	expect(expectErr(pulled).name).toBe('Partial');
	const pending = todos.git.pendingIncoming;
	expect(pending?.state).toBe('recorded');
	expect(incomingLine(todos.git)).toMatchObject({
		label: 'Incoming update not finished',
		tone: 'error',
	});
	expect(await text(todos, MILK)).toBe(before);

	// History waits; the folder says so, and nothing is changed.
	const commit = await todos.commitAndPush();
	expect(commit.commit.status).toBe('blocked');
	expect(expectErr(await todos.pull()).name).toBe('IncomingPending');
	expect(await text(todos, MILK)).toBe(before);

	// Editing, saving, and fetching continue.
	expectOk(await todos.folder.git.fetch());
	expect(await todos.create('Call mom')).toBeUndefined();
	const editor = todoEditor(todos);
	typeNotes(editor, 'Today.\n');
	expect(await written(editor)).toBeUndefined();
	expect(editor.isIdle).toBe(true);

	// Status and refreshes read the record; they resume nothing.
	await todos.check();
	expectOk(await todos.folder.git.status());
	expect(todos.git.pendingIncoming).toEqual(pending);
	expect(await text(todos, MILK)).toBe(before);

	// Reopening the folder reads the same record and resumes nothing.
	const files = [...opfs.files()].length;
	await todos.close();
	opened.splice(opened.indexOf(todos), 1);
	const again = await openTodos();
	for (let tries = 0; tries < 50 && !again.git.pendingIncoming; tries++)
		await Bun.sleep(5);
	expect(again.git.pendingIncoming).toEqual(pending);
	expect(await text(again, MILK)).toBe(before);
	expect([...opfs.files()].length).toBe(files);
}, 60_000);

test('recovery names a path in neither state and writes nothing, keeps the record until the person chooses a version in Files, then finishes; Files shows the result and the todo opens on it', async () => {
	const { todos, before } = await interruptedPull();
	const pending = todos.git.pendingIncoming;
	expect(pending?.state).toBe('recorded');

	// Milk is still at its before state; the person edits it to a third one.
	await todos.open(MILK, 'todos');
	const editor = todoEditor(todos);
	typeNotes(editor, 'My own note.\n');
	expect(await written(editor)).toBeUndefined();
	const third = (await text(todos, MILK))!;

	const refused = await todos.recoverIncoming();
	expect(refused).toMatchObject({
		kind: 'ran',
		result: { error: { name: 'RecoveryRefused', paths: [MILK] } },
	});
	const line = recoveryLine(refused);
	expect(line.label).toBe('Incoming update not recovered');
	expect(line.detail).toContain(MILK);
	expect(todos.lastRecovery).toMatchObject(refused);
	expect(todos.git.pendingIncoming).toEqual(pending);
	expect(await text(todos, MILK)).toBe(third);
	expect(fieldsOf(editor).body).toBe('My own note.\n');

	// The person chooses the version from before the update, as text in
	// Files. The todo editor settles and is let go first.
	await todos.open(MILK, 'files');
	const opened = todos.current?.item;
	if (opened?.kind !== 'text')
		throw new Error('Expected Files to open the text');
	expect(editor.isFenced).toBe(true);
	const file = opened.editor;
	expect(file.buffer).toBe(third);
	file.input(before);
	await file.save();
	expect(file.isIdle).toBe(true);
	expect(await text(todos, MILK)).toBe(before);

	// Now the update finishes. Files stays a text editor and shows what the
	// update wrote.
	const recovered = await todos.recoverIncoming();
	expect(recovered).toMatchObject({
		kind: 'ran',
		result: { data: { status: 'completed' } },
	});
	expect(todos.git.pendingIncoming).toBeUndefined();
	expect(await text(todos, MILK)).toBe(MILK_REMOTE);
	// The recovery's reread adopts it: the editor was clean.
	expect(file.buffer).toBe(MILK_REMOTE);
	expect(todos.current?.item).toMatchObject({ kind: 'text', editor: file });
	expect(incomingLine(todos.git)).toBeUndefined();

	// Opened again as a todo, explicitly, it reads the recovered row.
	await todos.open(MILK, 'todos');
	const reopened = todoEditor(todos);
	expect(reopened).not.toBe(editor);
	expect(fieldsOf(reopened).fields.title).toBe('Buy oat milk');
	expect(reopened.isIdle).toBe(true);
	// History continues.
	expect((await todos.commitAndPush()).commit.status).not.toBe('blocked');
}, 60_000);

test('a todo still opening when recovery starts is held with the rest: it refuses typing while the update runs, then shows what the update wrote', async () => {
	const landed = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<void>();
	// The folder writes the update, then its reply is held.
	const { todos, before } = await interruptedPull((folder) => ({
		...folder,
		git: {
			...folder.git,
			get snapshot() {
				return folder.git.snapshot;
			},
			async recoverIncoming() {
				const recovered = await folder.git.recoverIncoming();
				landed.resolve();
				await reply.promise;
				return recovered;
			},
		},
	}));
	const table = todos.folder.tables.todos;
	const edit = table.edit;
	const opened = Promise.withResolvers<void>();
	// The row editor opens on the file as it is now; its reply is held.
	table.edit = async (...args) => {
		const result = await edit(...args);
		await opened.promise;
		return result;
	};

	const opening = todos.open(MILK, 'todos');
	const recovering = todos.recoverIncoming();
	await Bun.sleep(20);
	expect(todos.recovering).toBe(true);
	opened.resolve();
	await opening;
	table.edit = edit;
	await landed.promise;

	// The editor opened on the row from before the update and was settled
	// and held: typing into it while the update's reply is held is refused.
	const editor = todoEditor(todos);
	expect(editor.isFenced).toBe(true);
	expect(fieldsOf(editor).fields.title).toBe('Buy milk');
	expect(typeNotes(editor, 'typed while recovering\n')).toContain(
		'still in progress',
	);
	expect(fieldsOf(editor).body).toBe('');
	expect(todos.recovering).toBe(true);
	expect(await text(todos, MILK)).toBe(MILK_REMOTE);

	reply.resolve();
	expect(await recovering).toMatchObject({
		kind: 'ran',
		result: { data: { status: 'completed' } },
	});
	// Once the hold lifts, the todo shows what the update wrote, and typing
	// writes on top of it: the old title from before it is never written back.
	expect(editor.isFenced).toBe(false);
	expect(fieldsOf(editor).fields.title).toBe('Buy oat milk');
	typeNotes(editor, 'typed after recovering\n');
	expect(await written(editor)).toBeUndefined();
	const saved = (await text(todos, MILK))!;
	expect(saved).not.toBe(before);
	expect(saved).not.toContain('Buy milk"');
	expect(inspectRow(todosDefinition.tables.todos, saved)).toMatchObject({
		fields: { title: 'Buy oat milk', done: true },
		body: 'typed after recovering\n',
	});
	expect(saved).toContain('"owner": "sam"');
}, 60_000);

test('recovery waits for open edits: a failed save stops it, and typing while it runs is refused, not saved over the update', async () => {
	const typing: { during?: () => void } = {};
	const { todos, before, opfs } = await interruptedPull((folder) => ({
		...folder,
		git: {
			...folder.git,
			get snapshot() {
				return folder.git.snapshot;
			},
			// Typing arrives once the editors are held, before the update
			// writes the row they show.
			recoverIncoming() {
				typing.during?.();
				return folder.git.recoverIncoming();
			},
		},
	}));
	const pending = todos.git.pendingIncoming;
	await todos.open(MILK, 'todos');
	const editor = todoEditor(todos);

	// A save that failed stops recovery before it runs.
	opfs.faults.write = (path) => {
		if (!path.endsWith(`/${MILK}`)) return undefined;
		opfs.faults.write = undefined;
		return 'fail';
	};
	typeNotes(editor, 'mine\n');
	expect(await written(editor)).toBeDefined();
	const unsettled = await todos.recoverIncoming();
	expect(unsettled).toEqual({ kind: 'unsettled', paths: [MILK] });
	expect(fieldsOf(editor).body).toBe('mine\n');
	expect(recoveryLine(unsettled).detail).toContain(MILK);
	expect(todos.git.pendingIncoming).toEqual(pending);
	expect(await text(todos, MILK)).toBe(before);

	// Reload drops the failed input; typing arrives while the update is written.
	expect(await todos.reload(MILK)).toBeUndefined();
	expect(await editor.settle()).toBe(true);
	expect(await text(todos, MILK)).toBe(before);
	typing.during = () => typeNotes(editor, 'typed during recovery\n');
	const recovered = await todos.recoverIncoming();
	expect(recovered).toMatchObject({
		kind: 'ran',
		result: { data: { status: 'completed' } },
	});

	// The typing was refused, not saved over the row; the todo shows the update.
	expect(fieldsOf(editor).fields.title).toBe('Buy oat milk');
	expect(fieldsOf(editor).body).toBe('Two cartons.\n');
	expect(editor.isIdle).toBe(true);
	expect(await text(todos, MILK)).toBe(MILK_REMOTE);
}, 60_000);

test('recovery fences each todo before it waits for the next: input that failed is kept, and typing while a later todo saves is refused, not reloaded away', async () => {
	const { todos, before, opfs } = await interruptedPull();
	const pending = todos.git.pendingIncoming;
	expectOk(
		await todos.folder.tables.todos.create({
			stem: 'eggs',
			fields: { title: 'Buy eggs', done: false },
		}),
	);
	// The eggs editor's next wait for its writes is held until released.
	type Gate = {
		readonly reached: PromiseWithResolvers<void>;
		readonly release: PromiseWithResolvers<void>;
	};
	let gate: Gate | undefined;
	const holdNextWait = (): Gate => {
		gate = {
			reached: Promise.withResolvers<void>(),
			release: Promise.withResolvers<void>(),
		};
		return gate;
	};
	const table = todos.folder.tables.todos;
	const edit = table.edit;
	table.edit = async (...args) => {
		const result = await edit(...args);
		if (result.error !== null || args[0] !== 'eggs') return result;
		const native = result.data;
		return Ok({
			...native,
			async waitForSaves() {
				const armed = gate;
				gate = undefined;
				if (armed !== undefined) {
					armed.reached.resolve();
					await armed.release.promise;
				}
				return native.waitForSaves();
			},
		});
	};
	await todos.open(MILK, 'todos');
	const milk = todoEditor(todos);
	await todos.open(EGGS, 'todos');
	const eggs = todoEditor(todos);
	table.edit = edit;

	// Milk's save is still running when recovery starts, and fails.
	opfs.faults.write = (path) => {
		if (!path.endsWith(`/${MILK}`)) return undefined;
		opfs.faults.write = undefined;
		return 'fail';
	};
	typeNotes(milk, 'mine\n');
	let held = holdNextWait();
	let recovering = todos.recoverIncoming();
	await held.reached.promise;

	// Milk is fenced before recovery waits for eggs.
	expect(milk.isFenced).toBe(true);
	expect(eggs.isFenced).toBe(true);
	expect(typeNotes(milk, 'typed while eggs saves\n')).toContain(
		'still in progress',
	);
	expect(fieldsOf(milk).body).toBe('mine\n');
	held.release.resolve();
	expect(await recovering).toEqual({ kind: 'unsettled', paths: [MILK] });
	// The failed input stays with its error; nothing was reloaded over it.
	expect(milk.isFenced).toBe(false);
	expect(fieldsOf(milk).body).toBe('mine\n');
	expect(milk.hasProblem).toBe(true);
	expect(await text(todos, MILK)).toBe(before);
	expect(todos.git.pendingIncoming).toEqual(pending);

	// Milk is clean now. Typing while recovery waits for eggs is refused, so
	// no save of it can fail and then be replaced by what the update wrote.
	expect(await todos.reload(MILK)).toBeUndefined();
	expect(milk.isIdle).toBe(true);
	held = holdNextWait();
	recovering = todos.recoverIncoming();
	await held.reached.promise;
	let attempted = false;
	opfs.faults.write = (path) => {
		if (!path.endsWith(`/${MILK}`)) return undefined;
		attempted = true;
		return 'fail';
	};
	expect(milk.isFenced).toBe(true);
	expect(typeNotes(milk, 'typed while eggs saves\n')).toContain(
		'still in progress',
	);
	expect(fieldsOf(milk).body).toBe('');
	expect(await written(milk)).toBeUndefined();
	expect(attempted).toBe(false);
	opfs.faults.write = undefined;
	held.release.resolve();
	expect(await recovering).toMatchObject({
		kind: 'ran',
		result: { data: { status: 'completed' } },
	});
	expect(milk.isFenced).toBe(false);
	expect(fieldsOf(milk).fields.title).toBe('Buy oat milk');
	expect(fieldsOf(milk).body).toBe('Two cartons.\n');
	expect(milk.isIdle).toBe(true);
	expect(await text(todos, MILK)).toBe(MILK_REMOTE);
	expect(eggs.isFenced).toBe(false);
	expect(fieldsOf(eggs).fields.title).toBe('Buy eggs');
}, 60_000);
