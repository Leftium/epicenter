/**
 * Todo Detail Mounted Tests
 *
 * Mounts the real `TodoDetail`, with its real `TodoStatus`, `FileNameBar`,
 * and `@epicenter/ui` controls, in jsdom over the real Todos owner
 * (`createTodos`) and a real browser folder on the in-memory OPFS stand-in.
 * A small host renders it the way `TodosView` does: one instance, reused
 * without a key as the selection moves. Typing goes through the DOM, into
 * the shared `Input` and `Textarea` and their function bindings.
 *
 * Key behaviors:
 * - Reusing the view from todo A to todo B shows B's own input and never
 *   carries A's into B; each input saves at its own path
 * - A todo removed elsewhere keeps its form and input when its write fails,
 *   and Close shows that it is gone
 * - Raw repair stays in raw mode after it validates until Edit fields. A
 *   control of a mode that left (source, Edit fields, title, notes,
 *   checkbox, Source tab) admits nothing, even after that mode returns;
 *   the returned mode's new controls edit the todo
 * - List completion reflects the owner after a source-mode refusal; ordinary
 *   completion and reopening preserve the current title, body, and metadata
 * - A failed save keeps the input on screen; disk C written by
 *   another writer replaces nothing, and Discard mine and reload shows C in
 *   the same editor
 * - Another writer's change is not shown until Reload, and the todo's next
 *   edit writes over it
 * - A refused title stays in its field with why while notes keep saving,
 *   and a corrected title saves and clears it
 * - A file made unreadable elsewhere keeps the form: Reload replaces nothing,
 *   and Try again after a failed save writes the exact last input over it
 * - A whole view that unmounts while the owner keeps its todo admits nothing
 *   from its detached fields, checkbox, file name bar, or status buttons,
 *   whether the retained todo is valid or holds a failed save; shown again,
 *   the same todo takes input and commands as before
 *
 * jsdom implements no layout, focus, selection, IME, or `inert`; a field
 * that left the document receiving input shows what a delivered event does,
 * not that a person can type there. Toasts, the confirmation dialog, and the
 * Tabs keyboard behavior are not exercised.
 *
 * Run with `bun run test:mounted`; the server-runtime tests exclude this file.
 */
import '../../lib/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { inspectRow, openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
	opfsOf,
} from '../../../../../packages/folder/src/browser-storage.test-support.js';
import { todosDefinition } from '../../lib/definition.js';
import { click, type } from '../../lib/svelte-dom.test-support.js';
import type { Todos } from '../../lib/todos.svelte.js';

const { flushSync, mount, unmount } = await import('svelte');
const { createTodos } = await import('../../lib/todos.svelte.ts');
const { default: TodoDetailHost } = await import(
	'./fixtures/TodoDetailHost.svelte'
);

const ROW = (title: string) => `---\ntitle: ${title}\ndone: false\n---\n`;
let count = 0;
const cleanup: (() => Promise<unknown> | void)[] = [];

afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** The real owner over a fresh browser folder, with the host mounted over it. */
async function setup() {
	const storage = createTestStorage();
	const folder = expectOk(
		await openFolder({
			id: `todo-detail-mounted-${count++}`,
			definition: todosDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				commitOnEdit: false,
				...browserStorage(storage),
			},
		}),
	);
	const todos: Todos = createTodos(folder);
	cleanup.push(() => todos.close());
	await todos.check();
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(TodoDetailHost, { target, props: { todos } });
	flushSync();
	cleanup.push(() => {
		void unmount(view);
		target.remove();
	});
	return {
		todos,
		opfs: opfsOf(storage),
		target,
		/** The selected todo's retained editor. */
		selected() {
			const selection = todos.selection;
			if (selection?.kind !== 'todo')
				throw new Error(`Expected an open todo, got ${selection?.kind}`);
			return selection.editor;
		},
		find<T extends Element = HTMLTextAreaElement>(selector: string) {
			return target.querySelector(selector) as T | null;
		},
		get<T extends Element = HTMLTextAreaElement>(selector: string): T {
			const element = target.querySelector(selector);
			if (element === null) throw new Error(`Nothing matches '${selector}'`);
			return element as unknown as T;
		},
		async text(path: string) {
			const { data } = await folder.files.read(path);
			return data === null ? undefined : new TextDecoder().decode(data.bytes);
		},
		async reading(path: string) {
			const { bytes } = expectOk(await folder.files.read(path));
			return inspectRow(
				todosDefinition.tables.todos,
				new TextDecoder().decode(bytes),
			);
		},
	};
}

const TITLE = 'input[aria-label="Title"]';
const NOTES = 'textarea[aria-label="Notes"]';
const SOURCE = 'textarea[aria-label="Markdown source"]';

/** Let replies and effects run, then render. */
async function settle() {
	for (let i = 0; i < 10; i++) await Bun.sleep(0);
	flushSync();
}

/** Wait for something the test did not request directly, then render. */
async function eventually(done: () => boolean) {
	for (let waited = 0; waited < 400 && !done(); waited++) {
		await Bun.sleep(5);
		flushSync();
	}
	flushSync();
}

/** The next write of `path` fails before it publishes: a definite failure. */
function failNextWrite(opfs: ReturnType<typeof opfsOf>, path: string) {
	opfs.faults.write = (file) => {
		if (!file.endsWith(`/${path}`)) return undefined;
		opfs.faults.write = undefined;
		return 'fail';
	};
}

test('the reused view shows each todo its own input: A then B then A, and each input saves at its own path', async () => {
	const { todos, get, selected, reading } = await setup();
	await todos.create('A');
	const pathA = todos.selectedPath!;
	await todos.create('B');
	const pathB = todos.selectedPath!;

	await todos.open(pathA);
	flushSync();
	const title = get<HTMLInputElement>(TITLE);
	const notes = get(NOTES);
	const a = selected();
	expect(title.value).toBe('A');
	type(title, 'A typed');
	expect(a.title()).toBe('A typed');

	// The same view and the same fields now belong to B.
	await todos.open(pathB);
	flushSync();
	const b = selected();
	expect(b).not.toBe(a);
	expect(get<HTMLInputElement>(TITLE)).toBe(title);
	expect(get(NOTES)).toBe(notes);
	expect(title.value).toBe('B');
	type(title, 'B typed');
	type(notes, 'B notes\n');
	expect(a.title()).toBe('A typed');
	expect(a.notes()).toBe('');

	await todos.open(pathA);
	flushSync();
	expect(title.value).toBe('A typed');
	expect(get(NOTES).value).toBe('');

	await eventually(() => a.isIdle && b.isIdle);
	expect(await reading(pathA)).toMatchObject({
		fields: { title: 'A typed', done: false },
		body: '',
	});
	expect(await reading(pathB)).toMatchObject({
		fields: { title: 'B typed', done: false },
		body: 'B notes\n',
	});
});

test('a todo removed elsewhere keeps its form and input when its write fails, and Close shows it is gone', async () => {
	const { todos, target, get, selected, text } = await setup();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	flushSync();
	const editor = selected();
	const { files } = todos.folder;
	expectOk(await files.remove(expectOk(await files.read(path))));

	const title = get<HTMLInputElement>(TITLE);
	type(title, 'Mine');
	await eventually(() => editor.editor.save.status === 'failed');
	expect(target.textContent).toContain('no longer in the folder');
	expect(title.value).toBe('Mine');
	expect(await text(path)).toBeUndefined();

	click(target, 'Close');
	await eventually(() => todos.selection === undefined);
	expect(target.querySelector('[data-view="no-todo"]')).not.toBeNull();
	expect(todos.selectedPath).toBe(path);
	expect(todos.unsaved).toBe(false);
	expect(await text(path)).toBeUndefined();
});

test('raw repair stays raw after it validates until Edit fields, and controls of a mode that left stay inert after it returns', async () => {
	const { todos, target, get, find, selected, text, reading } = await setup();
	const broken = '---\ntitle: *missing\n---\n';
	expectOk(await todos.folder.files.create('todos/bad.md', broken));
	await todos.refresh();
	await todos.open('todos/bad.md');
	flushSync();
	const editor = selected();
	expect(find(TITLE)).toBeNull();
	const source = get(SOURCE);
	expect(source.value).toBe(broken);
	expect(target.textContent).toContain('Needs repair');

	type(source, ROW('Fixed'));
	await eventually(() => editor.isIdle);
	expect(await text('todos/bad.md')).toBe(ROW('Fixed'));
	// Valid now, and still the raw view until the person chooses.
	expect(editor.editor.row.status).toBe('valid');
	expect(get(SOURCE)).toBe(source);
	expect(find(TITLE)).toBeNull();

	const editFields = button(target, 'Edit fields');
	click(target, 'Edit fields');
	flushSync();
	const title = get<HTMLInputElement>(TITLE);
	expect(title.value).toBe('Fixed');
	expect(find(SOURCE)).toBeNull();
	type(source, 'junk from the leaving source');
	expect(editor.editor.row.text).toBe(ROW('Fixed'));
	await settle();
	expect(await text('todos/bad.md')).toBe(ROW('Fixed'));

	// The source returns as a new block. The first source and its Edit fields
	// are gone for good: neither acts in the mode they belonged to.
	const notes = get(NOTES);
	const done = get<HTMLButtonElement>('button[aria-label="Done"]');
	click(target, 'Source');
	flushSync();
	expect(get(SOURCE)).not.toBe(source);
	type(source, 'junk from the first source');
	press(editFields);
	flushSync();
	expect(editor.editor.row.text).toBe(ROW('Fixed'));
	expect(editor.rawMode).toBe(true);

	// The fields return as new blocks. The first title, notes, checkbox, and
	// take nothing; the new ones edit the todo.
	click(target, 'Edit fields');
	flushSync();
	expect(get<HTMLInputElement>(TITLE)).not.toBe(title);
	type(title, 'from the first title');
	type(notes, 'from the first notes\n');
	press(done);
	flushSync();
	expect(editor.editor.row.text).toBe(ROW('Fixed'));
	expect(editor.rawMode).toBe(false);

	type(get<HTMLInputElement>(TITLE), 'Live');
	type(get(NOTES), 'live notes\n');
	press(get<HTMLButtonElement>('button[aria-label="Done"]'));
	await eventually(() => editor.isIdle);
	expect(await reading('todos/bad.md')).toMatchObject({
		fields: { title: 'Live', done: true },
		body: 'live notes\n',
	});
});

test('a failed save keeps the input; disk C replaces nothing, and Discard mine and reload shows C in the same editor', async () => {
	const { todos, opfs, target, get, selected, text } = await setup();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	flushSync();
	const editor = selected();
	failNextWrite(opfs, path);

	const title = get<HTMLInputElement>(TITLE);
	type(title, 'Mine');
	await eventually(() => editor.editor.save.status === 'failed');
	expect(target.textContent).toContain('Not saved');
	expect(title.value).toBe('Mine');

	// Another writer lands C. The failed input stays; C is not adopted.
	expectOk(await todos.folder.files.overwrite(path, ROW('Theirs')));
	await settle();
	expect(title.value).toBe('Mine');

	// A second failed attempt keeps newer typing available for deliberate reload.
	failNextWrite(opfs, path);
	type(title, 'Mine again');
	await editor.editor.waitForSaves();
	expect(await text(path)).toBe(ROW('Theirs'));
	expect(title.value).toBe('Mine again');

	click(target, 'Discard mine and reload');
	await eventually(() => editor.editor.save.status === 'idle');
	expect(selected()).toBe(editor);
	expect(get<HTMLInputElement>(TITLE).value).toBe('Theirs');
	expect(target.textContent).not.toContain('Not saved');
	expect(await text(path)).toBe(ROW('Theirs'));
});

test("another writer's change is not shown until Reload, and the todo's next edit writes over it", async () => {
	const { todos, target, get, selected, reading } = await setup();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	flushSync();
	const editor = selected();
	const title = get<HTMLInputElement>(TITLE);

	expectOk(await todos.folder.files.overwrite(path, ROW('Theirs')));
	await settle();
	expect(title.value).toBe('Milk');
	type(title, 'Mine');
	await eventually(() => editor.isIdle);
	expect((await reading(path)).fields.title).toBe('Mine');

	expectOk(await todos.folder.files.overwrite(path, ROW('Theirs again')));
	click(target, 'Reload');
	await eventually(() => title.value === 'Theirs again');
	expect(title.value).toBe('Theirs again');
	expect(editor.isIdle).toBe(true);
	expect((await reading(path)).fields.title).toBe('Theirs again');
});

test('a refused title stays in the field with why, and a corrected title saves and clears it', async () => {
	const { todos, target, get, selected, reading } = await setup();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	flushSync();
	const editor = selected();
	const title = get<HTMLInputElement>(TITLE);

	type(title, 'Oat \uD800');
	flushSync();
	expect(title.value).toBe('Oat \uD800');
	expect(target.textContent).toContain('title cannot be saved');
	expect(target.textContent).toContain('stays in the field');
	// Notes still save while the title is refused.
	type(get(NOTES), 'two cartons\n');
	await eventually(() => editor.editor.save.status === 'idle');
	expect(await reading(path)).toMatchObject({
		fields: { title: 'Milk' },
		body: 'two cartons\n',
	});
	expect(title.value).toBe('Oat \uD800');

	type(title, 'Oat');
	await eventually(() => editor.isIdle);
	expect(target.textContent).not.toContain('cannot be saved');
	expect((await reading(path)).fields.title).toBe('Oat');
});

/** Bytes that are not UTF-8 text: a file that is there but cannot be read as a todo. */
const CORRUPT = new Uint8Array([0xff, 0xfe, 0x00]);

test('a file made unreadable elsewhere keeps the form: Reload replaces nothing, and Try again after a failed save writes the exact last input over it', async () => {
	const { todos, opfs, target, get, find, selected } = await setup();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	flushSync();
	const editor = selected();
	failNextWrite(opfs, path);
	type(get<HTMLInputElement>(TITLE), 'Mine');
	await eventually(() => editor.editor.save.status === 'failed');
	const sent = editor.editor.row.text;
	expect(sent).toContain('"Mine"');

	expectOk(await todos.folder.files.overwrite(path, CORRUPT));
	expect(await todos.reload(path)).toContain('could not be read');
	await settle();
	expect(get<HTMLInputElement>(TITLE).value).toBe('Mine');
	expect(find(SOURCE)).toBeNull();
	expect(editor.editor.save.status).toBe('failed');
	expect(expectOk(await todos.folder.files.read(path)).bytes).toEqual(CORRUPT);

	click(target, 'Try again');
	await eventually(() => editor.isIdle);
	expect(
		new TextDecoder().decode(
			expectOk(await todos.folder.files.read(path)).bytes,
		),
	).toBe(sent);
	expect(get<HTMLInputElement>(TITLE).value).toBe('Mine');
});

/** Deliver a click to an element, attached or not. */
function press(element: Element) {
	element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** The button among `root`'s descendants whose text is `text`. */
function button(root: ParentNode, text: string) {
	const found = [...root.querySelectorAll('button')].find(
		(candidate) => candidate.textContent?.trim() === text,
	);
	if (found === undefined) throw new Error(`No button reads '${text}'`);
	return found;
}

test('a whole view that unmounts while its todo stays retained admits nothing from its detached fields, checkbox, or file name bar', async () => {
	const { todos, target, get, find, selected, reading } = await setup();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	flushSync();
	const editor = selected();
	const before = editor.editor.row.text;
	const title = get<HTMLInputElement>(TITLE);
	const notes = get(NOTES);
	const done = get<HTMLButtonElement>('button[aria-label="Done"]');
	const form = get<HTMLFormElement>('form');
	const name = get<HTMLInputElement>('form input');
	const remove = button(form, 'Delete');

	click(target, 'Hide detail');
	flushSync();
	expect(find(TITLE)).toBeNull();
	expect(target.querySelector('[data-view="hidden"]')).not.toBeNull();
	// The owner still retains the todo: valid, unfenced, and selected.
	expect(selected()).toBe(editor);
	expect(editor.editor.row.status).toBe('valid');
	expect(editor.isFenced).toBe(false);

	// Events still delivered to the view's detached nodes, one at a time.
	type(title, 'from a detached title');
	expect(editor.editor.row.text).toBe(before);
	type(notes, 'from detached notes\n');
	expect(editor.editor.row.text).toBe(before);
	press(done);
	expect(editor.editor.row.text).toBe(before);
	type(name, 'renamed');
	form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	press(remove);
	await settle();
	expect(await reading(path)).toMatchObject({
		fields: { title: 'Milk', done: false },
		body: '',
	});
	expect(todos.selectedPath).toBe(path);
	expect(todos.unsaved).toBe(false);

	// The raw view's textarea, detached the same way, admits nothing either.
	click(target, 'Show detail');
	flushSync();
	expect(editor.editSource()).toBeUndefined();
	flushSync();
	const source = get(SOURCE);
	click(target, 'Hide detail');
	flushSync();
	type(source, '---\ntitle: Detached\ndone: false\n---\n');
	expect(editor.editor.row.text).toBe(before);

	// Negative control: shown again, the same retained todo takes input.
	click(target, 'Show detail');
	flushSync();
	expect(editor.editFields()).toBeUndefined();
	flushSync();
	type(get<HTMLInputElement>(TITLE), 'Live');
	expect(editor.title()).toBe('Live');
	await eventually(() => editor.isIdle);
	expect((await reading(path)).fields.title).toBe('Live');
});

test("a hidden view's detached Try again and Discard mine and reload do nothing to a retained failed todo, and the shown view's own Try again still retries", async () => {
	const { todos, opfs, target, get, selected, reading } = await setup();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	flushSync();
	const editor = selected();
	failNextWrite(opfs, path);
	type(get<HTMLInputElement>(TITLE), 'Mine');
	await eventually(() => editor.editor.save.status === 'failed');
	const retry = button(target, 'Try again');
	const discard = button(target, 'Discard mine and reload');

	click(target, 'Hide detail');
	flushSync();
	press(retry);
	press(discard);
	await settle();
	// No new attempt, and the failed input is still the todo's.
	expect(selected()).toBe(editor);
	expect(editor.editor.save.status).toBe('failed');
	expect(editor.title()).toBe('Mine');
	expect((await reading(path)).fields.title).toBe('Milk');

	// Negative control: the shown view's own Try again is a new attempt.
	click(target, 'Show detail');
	flushSync();
	click(target, 'Try again');
	await eventually(() => editor.editor.save.status === 'idle');
	expect(selected()).toBe(editor);
	expect((await reading(path)).fields.title).toBe('Mine');
});

test('list completion follows the owner after a source-mode refusal, and completion and reopening keep unrelated input', async () => {
	const { todos, selected, reading, text } = await setup();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const editor = selected();
	expect(editor.editSource()).toBeUndefined();
	editor.setText('---\ntitle: Milk\ndone: false\nowner: keep-me\n---\nCurrent notes.');
	await eventually(() => editor.isIdle);
	const before = editor.editor.row.text;

	const { default: TodoList } = await import('./TodoList.svelte');
	const listTarget = document.createElement('div');
	document.body.append(listTarget);
	const list = mount(TodoList, { target: listTarget, props: { todos } });
	cleanup.push(async () => {
		await unmount(list);
		listTarget.remove();
	});
	flushSync();
	const completion = listTarget.querySelector<HTMLButtonElement>('[role="checkbox"]');
	if (completion === null) throw new Error('No list completion control');

	press(completion);
	await settle();
	expect(completion.getAttribute('aria-checked')).toBe('false');
	expect(editor.rawMode).toBe(true);
	expect(editor.editor.row.text).toBe(before);
	expect((await reading(path)).fields.done).toBe(false);

	expect(editor.editFields()).toBeUndefined();
	flushSync();
	press(completion);
	await eventually(() => editor.done() && editor.isIdle);
	expect(completion.getAttribute('aria-checked')).toBe('true');
	expect(await reading(path)).toMatchObject({
		fields: { title: 'Milk', done: true },
		body: 'Current notes.',
	});
	expect(await text(path)).toContain('keep-me');
	press(completion);
	await eventually(() => !editor.done() && editor.isIdle);
	expect(completion.getAttribute('aria-checked')).toBe('false');
	expect(await reading(path)).toMatchObject({
		fields: { title: 'Milk', done: false },
		body: 'Current notes.',
	});
	expect(await text(path)).toContain('keep-me');
});
