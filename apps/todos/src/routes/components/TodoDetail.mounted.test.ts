/**
 * Todo Detail Mounted Tests
 *
 * Mounts the real detail pane (`Detail`, which `TodosView` renders), with
 * its real `TodoDetail`, `FileView`, `Handoff`, `TodoStatus`, `FileNameBar`,
 * and `@epicenter/ui` controls, in jsdom over the real Todos owner
 * (`createTodos`) and a real browser folder on the in-memory OPFS stand-in.
 * Each editor view is keyed by its editor. Typing goes through the DOM, into
 * the shared `Input` and `Textarea` and their function bindings.
 *
 * Key behaviors:
 * - Each todo gets its own view: A then B then A mounts new controls, a
 *   control left over from A's view admits nothing, and each input saves at
 *   its own path
 * - A todo removed elsewhere keeps its form and input when its write fails,
 *   and Close shows that it is gone
 * - Files opens a todo's complete text and the list opens its fields. A
 *   malformed row opened as a todo shows why and Open in Files, with no
 *   fields and no source editor; repaired in Files it stays text until Open
 *   as todo, which shows its fields in a new view
 * - A todo whose write failed stays in Files' detail with its input, Try
 *   again, and Back to the todo; once saved, Files opens its text, and the
 *   todo view's detached controls admit nothing to the released editor or
 *   the new one at the same path
 * - List completion while Files shows the file is assigned in Files' text,
 *   unsaved typing included, and saved by that same editor; the textarea
 *   stays. Ordinary completion and reopening preserve the current title,
 *   body, and metadata
 * - A failed save keeps the input on screen; disk C written by
 *   another writer replaces nothing, and Discard mine and reload shows C in
 *   the same editor
 * - Another writer's change is not shown until Reload, and the todo's next
 *   edit writes over it
 * - A title or notes value the todo cannot take changes nothing: after the
 *   event the control shows the row again, a notice says why, and the same
 *   refusal again is a new notice. A failed save keeps its input and message
 *   beside a later refusal, and Try again still saves it
 * - A file made unreadable elsewhere keeps the form: Reload replaces nothing,
 *   and Try again after a failed save writes the exact last input over it
 * - A whole view that unmounts while the owner keeps its todo admits nothing
 *   from its detached fields, checkbox, file name bar, or status buttons,
 *   whether the retained todo is valid or holds a failed save; shown again,
 *   the same todo takes input and commands as before
 *
 * jsdom implements no layout, focus, selection, IME, or `inert`; a field
 * that left the document receiving input shows what a delivered event does,
 * not that a person can type there. Toasts, the clipboard, and the
 * confirmation dialog are not exercised.
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
import type { TodoEditor } from '../../lib/todo-editor.svelte.js';
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
		/** The retained todo editor the detail shows. */
		selected() {
			const item = todos.current?.item;
			if (item?.kind !== 'todo')
				throw new Error(`Expected an open todo, got ${item?.kind}`);
			return item.editor;
		},
		/** The path the detail shows. */
		shown() {
			return todos.current!.path;
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
/** Files' complete-text editor, whatever the file. */
const CONTENTS = 'textarea[aria-label^="Contents of"]';

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

/** Whether the todo's current row is checked done. */
function isDone(editor: TodoEditor) {
	return editor.row.status === 'valid' && editor.row.fields.done === true;
}

/** The next write of `path` fails before it publishes: a definite failure. */
function failNextWrite(opfs: ReturnType<typeof opfsOf>, path: string) {
	opfs.faults.write = (file) => {
		if (!file.endsWith(`/${path}`)) return undefined;
		opfs.faults.write = undefined;
		return 'fail';
	};
}

test("each todo gets its own view: A then B then A mounts new controls, A's left-over controls admit nothing, and each input saves at its own path", async () => {
	const { todos, get, selected, shown, reading } = await setup();
	await todos.create('A');
	const pathA = shown();
	await todos.create('B');
	const pathB = shown();

	await todos.open(pathA, 'todos');
	flushSync();
	const title = get<HTMLInputElement>(TITLE);
	const notes = get(NOTES);
	const a = selected();
	expect(title.value).toBe('A');
	type(title, 'A typed');
	expect(a.row).toMatchObject({ fields: { title: 'A typed' } });

	// B's view is a new one, bound to B for its whole lifetime.
	await todos.open(pathB, 'todos');
	flushSync();
	const b = selected();
	expect(b).not.toBe(a);
	expect(get<HTMLInputElement>(TITLE)).not.toBe(title);
	expect(get(NOTES)).not.toBe(notes);
	expect(get<HTMLInputElement>(TITLE).value).toBe('B');
	// A's controls left the document; what still reaches them changes nothing.
	type(title, 'from A, detached');
	type(notes, 'from A, detached\n');
	type(get<HTMLInputElement>(TITLE), 'B typed');
	type(get(NOTES), 'B notes\n');
	expect(a.row).toMatchObject({ fields: { title: 'A typed' }, body: '' });
	expect(b.row).toMatchObject({
		fields: { title: 'B typed' },
		body: 'B notes\n',
	});

	await todos.open(pathA, 'todos');
	flushSync();
	expect(get<HTMLInputElement>(TITLE).value).toBe('A typed');
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
	const { todos, target, get, find, selected, shown, text } = await setup();
	await todos.create('Milk');
	const path = shown();
	flushSync();
	const editor = selected();
	const { files } = todos.folder;
	expectOk(await files.remove(expectOk(await files.read(path))));

	const title = get<HTMLInputElement>(TITLE);
	type(title, 'Mine');
	await eventually(() => editor.save.status === 'failed');
	expect(target.textContent).toContain('no longer in the folder');
	expect(title.value).toBe('Mine');
	expect(await text(path)).toBeUndefined();

	click(target, 'Close');
	await eventually(() => todos.current?.item === undefined);
	expect(find(TITLE)).toBeNull();
	expect(target.textContent).toContain('is no longer in the folder');
	expect(shown()).toBe(path);
	expect(todos.unsaved).toBe(false);
	expect(await text(path)).toBeUndefined();
});

test('Files opens the complete text and the list opens fields; a malformed todo shows why and Open in Files, and repaired in Files it stays text until Open as todo', async () => {
	const { todos, target, get, find, selected, text, reading } = await setup();
	expectOk(await todos.folder.files.create('todos/milk.md', ROW('Milk')));
	const broken = '---\ntitle: *missing\n---\n';
	expectOk(await todos.folder.files.create('todos/bad.md', broken));
	await todos.check();
	expect(todos.repairs.map((repair) => repair.path)).toEqual(['todos/bad.md']);

	// The same file, from each surface.
	await todos.open('todos/milk.md', 'files');
	flushSync();
	expect(get(CONTENTS).value).toBe(ROW('Milk'));
	expect(find(TITLE)).toBeNull();
	await todos.open('todos/milk.md', 'todos');
	flushSync();
	expect(get<HTMLInputElement>(TITLE).value).toBe('Milk');
	expect(find(CONTENTS)).toBeNull();

	// A malformed row opened as a todo says why and offers Files, nothing else.
	await todos.open('todos/bad.md', 'todos');
	flushSync();
	const bad = selected();
	expect(bad.row.status).toBe('invalid');
	expect(target.textContent).toContain('Needs repair');
	expect(find(TITLE)).toBeNull();
	expect(find(NOTES)).toBeNull();
	expect(find(CONTENTS)).toBeNull();
	expect(find('button[aria-label="Done"]')).toBeNull();
	click(target, 'Open in Files');
	await eventually(() => find(CONTENTS) !== null);
	const contents = get(CONTENTS);
	expect(contents.value).toBe(broken);
	expect(bad.isFenced).toBe(true);

	// Repair in Files. Valid now, and still the text editor.
	type(contents, ROW('Fixed'));
	await eventually(
		() =>
			todos.current?.item?.kind === 'text' && todos.current.item.editor.isIdle,
	);
	expect(await text('todos/bad.md')).toBe(ROW('Fixed'));
	await todos.check();
	flushSync();
	expect(todos.repairs).toEqual([]);
	expect(get(CONTENTS)).toBe(contents);
	expect(find(TITLE)).toBeNull();

	// Open as todo is a new view on a new editor.
	click(target, 'Open as todo');
	await eventually(() => find(TITLE) !== null);
	const fixed = selected();
	expect(fixed).not.toBe(bad);
	expect(get<HTMLInputElement>(TITLE).value).toBe('Fixed');
	// Files' textarea left; what still reaches it writes nothing.
	type(contents, 'junk from the departed text');
	type(get<HTMLInputElement>(TITLE), 'Live');
	type(get(NOTES), 'live notes\n');
	press(get<HTMLButtonElement>('button[aria-label="Done"]'));
	await eventually(() => fixed.isIdle);
	expect(await reading('todos/bad.md')).toMatchObject({
		fields: { title: 'Live', done: true },
		body: 'live notes\n',
	});
});

test("a todo whose write failed stays in Files' detail with its input, Try again, and Back to the todo; once saved Files opens its text, and the todo view's detached controls admit nothing", async () => {
	const { todos, opfs, target, get, find, selected, shown, text } =
		await setup();
	await todos.create('Milk');
	const path = shown();
	flushSync();
	const editor = selected();
	const title = get<HTMLInputElement>(TITLE);
	const done = get<HTMLButtonElement>('button[aria-label="Done"]');
	failNextWrite(opfs, path);
	type(title, 'Mine');
	await eventually(() => editor.save.status === 'failed');

	click(target, 'Open in Files');
	await settle();
	// Nothing opened on the file in its place; the todo and its input stay.
	expect(todos.current).toMatchObject({ workspace: 'files', path });
	expect(find(CONTENTS)).toBeNull();
	expect(find(TITLE)).toBeNull();
	expect(target.textContent).toContain('Not saved');
	expect(target.textContent).toContain('still has');
	expect(button(target, 'Back to the todo')).toBeDefined();
	expect(button(target, 'Copy text')).toBeDefined();
	expect(editor.row).toMatchObject({ fields: { title: 'Mine' } });
	expect(todos.unsaved).toBe(true);

	// The todo view's controls left the document; what reaches them changes nothing.
	type(title, 'from the departed title');
	press(done);
	expect(editor.row).toMatchObject({ fields: { title: 'Mine', done: false } });

	click(target, 'Try again');
	await eventually(() => editor.isIdle);
	const saved = (await text(path))!;
	expect(saved).toContain('"Mine"');
	click(target, 'Open its text');
	await eventually(() => find(CONTENTS) !== null);
	expect(get(CONTENTS).value).toBe(saved);

	// The todo opens again on a new editor at the same path; the first
	// view's detached controls reach neither.
	await todos.open(path, 'todos');
	flushSync();
	const reopened = selected();
	expect(reopened).not.toBe(editor);
	type(title, 'from the first view');
	press(done);
	await settle();
	expect(reopened.row).toMatchObject({
		fields: { title: 'Mine', done: false },
	});
	expect(editor.row).toMatchObject({ fields: { title: 'Mine', done: false } });
	expect(await text(path)).toBe(saved);
});

test('a failed save keeps the input; disk C replaces nothing, and Discard mine and reload shows C in the same editor', async () => {
	const { todos, opfs, target, get, selected, text } = await setup();
	await todos.create('Milk');
	const path = todos.current!.path;
	flushSync();
	const editor = selected();
	failNextWrite(opfs, path);

	const title = get<HTMLInputElement>(TITLE);
	type(title, 'Mine');
	await eventually(() => editor.save.status === 'failed');
	expect(target.textContent).toContain('Not saved');
	expect(title.value).toBe('Mine');

	// Another writer lands C. The failed input stays; C is not adopted.
	expectOk(await todos.folder.files.overwrite(path, ROW('Theirs')));
	await settle();
	expect(title.value).toBe('Mine');

	// A second failed attempt keeps newer typing available for deliberate reload.
	failNextWrite(opfs, path);
	type(title, 'Mine again');
	await editor.settle();
	expect(await text(path)).toBe(ROW('Theirs'));
	expect(title.value).toBe('Mine again');

	click(target, 'Discard mine and reload');
	await eventually(() => editor.save.status === 'idle');
	expect(selected()).toBe(editor);
	expect(get<HTMLInputElement>(TITLE).value).toBe('Theirs');
	expect(target.textContent).not.toContain('Not saved');
	expect(await text(path)).toBe(ROW('Theirs'));
});

test("another writer's change is not shown until Reload, and the todo's next edit writes over it", async () => {
	const { todos, target, get, selected, reading } = await setup();
	await todos.create('Milk');
	const path = todos.current!.path;
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

/**
 * Type `value`, which must not be well formed, into `element`. Checked before
 * the event, so a normalized replacement character cannot pass for a refusal.
 */
function typeMalformed(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
	element.value = value;
	expect(element.value.isWellFormed()).toBe(false);
	element.dispatchEvent(new window.Event('input', { bubbles: true }));
}

test('a title or notes the todo cannot take snaps back to the row after the event, and the same refusal again is a new notice', async () => {
	const { todos, target, get, find, selected, reading } = await setup();
	await todos.create('Milk');
	const path = todos.current!.path;
	flushSync();
	const editor = selected();
	const before = editor.row.text;
	const title = get<HTMLInputElement>(TITLE);
	const notes = get(NOTES);
	const notice = () => find<HTMLElement>('[data-testid="todo-refusal"]');

	typeMalformed(title, 'Oat \uD800');
	await settle();
	expect(editor.row.text).toBe(before);
	expect(title.value).toBe('Milk');
	const first = notice();
	expect(first?.getAttribute('role')).toBe('alert');
	expect(first?.textContent).toContain('not taken');

	typeMalformed(notes, 'two \uD800');
	await settle();
	expect(notes.value).toBe('');
	const second = notice();
	typeMalformed(notes, 'two \uD800');
	await settle();
	expect(notes.value).toBe('');
	// The same reason again replaces the alert, so it is announced again.
	expect(notice()).not.toBe(second);
	expect(notice()?.textContent).toBe(second?.textContent);
	expect(editor.row.text).toBe(before);
	expect(todos.unsaved).toBe(false);
	expect(await reading(path)).toMatchObject({ fields: { title: 'Milk' }, body: '' });

	// Accepted typing clears the notice and saves.
	type(title, 'Oat');
	await eventually(() => editor.isIdle);
	expect(notice()).toBeNull();
	expect((await reading(path)).fields.title).toBe('Oat');
});

test('a refusal after a failed save keeps the failed input and its message, and Try again saves it', async () => {
	const { todos, opfs, target, get, find, selected, reading } = await setup();
	await todos.create('Milk');
	const path = todos.current!.path;
	flushSync();
	const editor = selected();
	const title = get<HTMLInputElement>(TITLE);
	failNextWrite(opfs, path);
	type(title, 'Mine');
	await eventually(() => editor.save.status === 'failed');

	typeMalformed(title, 'Mine \uD800');
	await settle();
	// The control shows the accepted, unsaved input, not the file.
	expect(title.value).toBe('Mine');
	expect(editor.save.status).toBe('failed');
	expect(target.textContent).toContain('Not saved');
	expect(find('[data-testid="todo-refusal"]')?.textContent).toContain('not taken');
	expect(todos.unsaved).toBe(true);

	click(target, 'Try again');
	await eventually(() => editor.isIdle);
	expect((await reading(path)).fields.title).toBe('Mine');
	expect(target.textContent).not.toContain('Not saved');
});

test("notes and Files' text show LF, and typing in them keeps the file's CRLF and undeclared keys", async () => {
	const { todos, target, get, find, selected, text, reading } = await setup();
	const crlf =
		'---\r\ntitle: Milk\r\ndone: false\r\nowner: sam\r\n---\r\nOne\r\nTwo\r\n';
	expectOk(await todos.folder.files.create('todos/crlf.md', crlf));
	await todos.refresh();
	await todos.open('todos/crlf.md', 'todos');
	flushSync();
	const editor = selected();
	const notes = get(NOTES);
	expect(notes.value).toBe('One\nTwo\n');

	type(notes, 'One\nTwo\nThree\n');
	await eventually(() => editor.isIdle);
	// The body keeps the file's CRLF; the frontmatter is written canonically.
	expect(await reading('todos/crlf.md')).toMatchObject({
		fields: { title: 'Milk', done: false },
		body: 'One\r\nTwo\r\nThree\r\n',
	});
	expect(await text('todos/crlf.md')).toContain('"owner": "sam"');

	click(target, 'Open in Files');
	await eventually(() => find(CONTENTS) !== null);
	const contents = get(CONTENTS);
	const saved = (await text('todos/crlf.md'))!;
	expect(contents.value).toBe(saved.replace(/\r\n/g, '\n'));
	const typed = contents.value.replace('Three', 'Four');
	type(contents, typed);
	await eventually(
		() =>
			todos.current?.item?.kind === 'text' && todos.current.item.editor.isIdle,
	);
	expect(await text('todos/crlf.md')).toBe(typed.replace(/\n/g, '\r\n'));
});

/** Bytes that are not UTF-8 text: a file that is there but cannot be read as a todo. */
const CORRUPT = new Uint8Array([0xff, 0xfe, 0x00]);

test('a file made unreadable elsewhere keeps the form: Reload replaces nothing, and Try again after a failed save writes the exact last input over it', async () => {
	const { todos, opfs, target, get, find, selected } = await setup();
	await todos.create('Milk');
	const path = todos.current!.path;
	flushSync();
	const editor = selected();
	failNextWrite(opfs, path);
	type(get<HTMLInputElement>(TITLE), 'Mine');
	await eventually(() => editor.save.status === 'failed');
	const sent = editor.row.text;
	expect(sent).toContain('"Mine"');

	expectOk(await todos.folder.files.overwrite(path, CORRUPT));
	expect(await todos.reload(path)).toContain('could not be read');
	await settle();
	expect(get<HTMLInputElement>(TITLE).value).toBe('Mine');
	expect(find(CONTENTS)).toBeNull();
	expect(editor.save.status).toBe('failed');
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
	const path = todos.current!.path;
	flushSync();
	const editor = selected();
	const before = editor.row.text;
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
	expect(editor.row.status).toBe('valid');
	expect(editor.isFenced).toBe(false);

	// Events still delivered to the view's detached nodes, one at a time.
	type(title, 'from a detached title');
	expect(editor.row.text).toBe(before);
	type(notes, 'from detached notes\n');
	expect(editor.row.text).toBe(before);
	press(done);
	expect(editor.row.text).toBe(before);
	type(name, 'renamed');
	form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	press(remove);
	await settle();
	expect(await reading(path)).toMatchObject({
		fields: { title: 'Milk', done: false },
		body: '',
	});
	expect(todos.current?.path).toBe(path);
	expect(todos.unsaved).toBe(false);

	// Negative control: shown again, the same retained todo takes input.
	click(target, 'Show detail');
	flushSync();
	expect(selected()).toBe(editor);
	type(get<HTMLInputElement>(TITLE), 'Live');
	expect(editor.row).toMatchObject({ fields: { title: 'Live' } });
	await eventually(() => editor.isIdle);
	expect((await reading(path)).fields.title).toBe('Live');
});

test("a hidden view's detached Try again and Discard mine and reload do nothing to a retained failed todo, and the shown view's own Try again still retries", async () => {
	const { todos, opfs, target, get, selected, reading } = await setup();
	await todos.create('Milk');
	const path = todos.current!.path;
	flushSync();
	const editor = selected();
	failNextWrite(opfs, path);
	type(get<HTMLInputElement>(TITLE), 'Mine');
	await eventually(() => editor.save.status === 'failed');
	const retry = button(target, 'Try again');
	const discard = button(target, 'Discard mine and reload');

	click(target, 'Hide detail');
	flushSync();
	press(retry);
	press(discard);
	await settle();
	// No new attempt, and the failed input is still the todo's.
	expect(selected()).toBe(editor);
	expect(editor.save.status).toBe('failed');
	expect(editor.row).toMatchObject({ fields: { title: 'Mine' } });
	expect((await reading(path)).fields.title).toBe('Milk');

	// Negative control: the shown view's own Try again is a new attempt.
	click(target, 'Show detail');
	flushSync();
	click(target, 'Try again');
	await eventually(() => editor.save.status === 'idle');
	expect(selected()).toBe(editor);
	expect((await reading(path)).fields.title).toBe('Mine');
});

test("list completion while Files shows the same file goes through Files' editor, keeping its typing and view; opened as a todo, completion and reopening keep unrelated input", async () => {
	const { todos, target, get, selected, reading, text } = await setup();
	const path = 'todos/milk.md';
	const source =
		'---\ntitle: Milk\ndone: false\nowner: keep-me\n---\nCurrent notes.';
	expectOk(await todos.folder.files.create(path, source));
	await todos.refresh();
	await todos.open(path, 'files');
	flushSync();
	const contents = get(CONTENTS);
	expect(contents.value).toBe(source);

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

	// Files' plain editor is the file's one publisher: completion is assigned
	// in its text, typing not yet saved included, and it saves it. The text
	// view and its textarea stay.
	type(contents, `${source}\nTyped in Files.`);
	press(completion);
	const typedDone = `${source.replace('done: false', 'done: true')}\nTyped in Files.`;
	await eventually(() => completion.getAttribute('aria-checked') === 'true');
	expect(completion.getAttribute('aria-checked')).toBe('true');
	expect(get(CONTENTS)).toBe(contents);
	expect(contents.value).toBe(typedDone);
	expect(await text(path)).toBe(typedDone);
	expect(todos.current).toMatchObject({ workspace: 'files', path });
	press(completion);
	await eventually(() => completion.getAttribute('aria-checked') === 'false');
	expect(contents.value).toBe(`${source}\nTyped in Files.`);
	expect(await text(path)).toBe(`${source}\nTyped in Files.`);

	click(target, 'Open as todo');
	await eventually(() => todos.current?.item?.kind === 'todo');
	const editor = selected();
	press(completion);
	await eventually(
		() => isDone(editor) && editor.isIdle && completion.getAttribute('aria-checked') === 'true',
	);
	expect(completion.getAttribute('aria-checked')).toBe('true');
	expect(await reading(path)).toMatchObject({
		fields: { title: 'Milk', done: true },
		body: 'Current notes.\nTyped in Files.',
	});
	expect(await text(path)).toContain('keep-me');
	press(completion);
	await eventually(
		() => !isDone(editor) && editor.isIdle && completion.getAttribute('aria-checked') === 'false',
	);
	expect(completion.getAttribute('aria-checked')).toBe('false');
	expect(await reading(path)).toMatchObject({
		fields: { title: 'Milk', done: false },
		body: 'Current notes.\nTyped in Files.',
	});
	expect(await text(path)).toContain('keep-me');
});

test('a retired Files discard button cannot discard the newer todo editor at the same path', async () => {
	const { todos, target, get, opfs, selected } = await setup();
	const path = 'todos/milk.md';
	expectOk(await todos.folder.files.create(path, ROW('Milk')));
	await todos.open(path, 'files');
	flushSync();
	const item = todos.current?.item;
	if (item?.kind !== 'text') throw new Error('Expected Files editor');
	failNextWrite(opfs, path);
	type(get(CONTENTS), ROW('Mine'));
	await item.editor.save();
	flushSync();
	const discard = button(target, 'Discard mine');
	await item.editor.retry();
	await todos.open(path, 'todos');
	flushSync();
	const editor = selected();
	expectOk(
		await todos.folder.files.remove(
			expectOk(await todos.folder.files.read(path)),
		),
	);
	type(get<HTMLInputElement>(TITLE), 'Newer accepted input');
	await eventually(() => editor.save.status === 'failed');
	press(discard);
	await settle();
	expect(selected()).toBe(editor);
	expect(editor.row.status === 'valid' && editor.row.fields.title).toBe(
		'Newer accepted input',
	);
});
