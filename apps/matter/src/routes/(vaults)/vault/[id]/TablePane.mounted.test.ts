/**
 * Row Body Editing Mounted Tests
 *
 * Mounts the real `TablePane`, with its `TableGrid`, `RowDetailDialog`, the
 * CodeMirror `MarkdownBodyEditor`, and `@epicenter/ui`, in jsdom over a real
 * `createVault` and its `createTable`s. Tauri IPC is `mockIPC` over an
 * in-memory folder whose writes can be held or failed, and whose watcher
 * batches the test delivers by hand. A fixture host keys the pane on the active
 * table as VaultShell does and switches tables with buttons.
 *
 * Key behaviors:
 * - Each change in the body widget saves the whole body at once, with no blur,
 *   keeping frontmatter another writer added; each row's editor writes only
 *   its own file
 * - While a write runs, later input waits and only the newest is written next;
 *   neither that write landing nor a late watcher echo of it replaces newer text
 * - A failed save keeps the text and its reason through closing the dialog and
 *   switching tables; Try again saves it
 * - A file removed elsewhere is not recreated, and malformed frontmatter is not
 *   overwritten: the bytes stay, the reason shows, and the text stays in the
 *   pane after the dialog closes on its own
 * - An untouched editor follows another writer; after typing, another writer's
 *   body waits for "Discard my text"
 *
 * Typing is a CodeMirror input transaction dispatched to the mounted view, the
 * transaction a keystroke produces; jsdom has no layout, focus, selection, or
 * IME, so this is not proof that a person can type there. The table owns
 * retained text for its lifetime only: closing the vault or quitting the app
 * is not covered and drops it.
 *
 * Run with `bun run test:mounted`; plain `bun test` excludes this file.
 */
import '../../../../lib/svelte-dom.test-support.ts';
import { afterEach, expect, test } from 'bun:test';
import { EditorView } from '@codemirror/view';
import { parseMarkdown } from '@epicenter/matter-core';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import type { FileDelta } from '../../../../lib/bindings/FileDelta';
import { click } from '../../../../lib/svelte-dom.test-support.ts';

const { flushSync, mount, unmount } = await import('svelte');
const { createVault } = await import('../../../../lib/vault.svelte.ts');
const { default: TablePaneHost } = await import(
	'./fixtures/TablePaneHost.svelte'
);

const CONTRACT = JSON.stringify({ fields: { title: { type: 'string' } } });
const cleanup: (() => void)[] = [];

afterEach(() => {
	for (const step of cleanup.splice(0).reverse()) step();
});

type Channel<T> = { onmessage?: (message: T) => void };

/**
 * An in-memory vault behind the Tauri commands Matter calls: `notes` and
 * `ideas` tables under `/vault`. Writes land on `disk` and are recorded; the
 * watcher sends nothing after its seed until the test calls `echo`.
 */
function fakeVault() {
	const disk = new Map<string, Map<string, string>>([
		[
			'/vault/notes',
			new Map([
				['matter.json', CONTRACT],
				['a.md', '---\ntitle: A\n---\nfirst body\n'],
				['b.md', '---\ntitle: B\n---\nsecond body\n'],
			]),
		],
		[
			'/vault/ideas',
			new Map([
				['matter.json', CONTRACT],
				['c.md', '---\ntitle: C\n---\nthird body\n'],
			]),
		],
	]);
	const watchers = new Map<string, Channel<FileDelta[]>>();
	const writes: { fileName: string; content: string }[] = [];
	const held: (() => void)[] = [];
	const control = {
		/** When true, each write waits in `held` until released. */
		hold: false,
		/** When set, each write fails with this message. */
		failure: undefined as string | undefined,
	};
	let nextId = 1;

	mockIPC(async (cmd, payload) => {
		const args = (payload ?? {}) as Record<string, unknown>;
		switch (cmd) {
			case 'watch_vault': {
				const channel = args.channel as Channel<string[]>;
				queueMicrotask(() => channel.onmessage?.([...disk.keys()]));
				return nextId++;
			}
			case 'watch_folder': {
				const path = args.path as string;
				const channel = args.channel as Channel<FileDelta[]>;
				watchers.set(path, channel);
				const seed = [...(disk.get(path) ?? [])].map(
					([fileName, text]): FileDelta => ({
						kind: 'content',
						fileName,
						text,
					}),
				);
				queueMicrotask(() => channel.onmessage?.(seed));
				return nextId++;
			}
			case 'unwatch_vault':
			case 'unwatch_folder':
			case 'reset_mirror':
			case 'write_mirror':
			case 'drop_mirror_table':
				return null;
			case 'query_mirror':
				return { columns: [], rows: [] };
			case 'read_entry':
				return (
					disk.get(args.path as string)?.get(args.fileName as string) ?? null
				);
			case 'write_entry': {
				if (control.hold) await new Promise<void>((go) => held.push(go));
				if (control.failure) throw control.failure;
				const fileName = args.fileName as string;
				const content = args.content as string;
				disk.get(args.path as string)?.set(fileName, content);
				writes.push({ fileName, content });
				return null;
			}
		}
		throw new Error(`Unhandled command ${cmd}`);
	});

	return {
		control,
		writes,
		notes: disk.get('/vault/notes') as Map<string, string>,
		/** How many writes are waiting to be released. */
		get heldWrites() {
			return held.length;
		},
		/** Release the oldest held write. */
		release() {
			held.shift()?.();
		},
		/** Deliver one watcher batch for `notes`, as the native watcher would. */
		echo(...deltas: FileDelta[]) {
			watchers.get('/vault/notes')?.onmessage?.(deltas);
			flushSync();
		},
	};
}

async function until(check: () => boolean, what: string) {
	for (let attempt = 0; attempt < 200; attempt++) {
		flushSync();
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(
		`Timed out waiting for ${what}; the page reads: ${pageText().slice(0, 500)}`,
	);
}

async function setup() {
	const fake = fakeVault();
	const vault = createVault('/vault');
	const target = document.createElement('div');
	document.body.append(target);
	const host = mount(TablePaneHost, { target, props: { vault } });
	cleanup.push(() => {
		unmount(host);
		flushSync();
		vault.dispose();
		clearMocks();
		document.body.replaceChildren();
	});
	await until(() => rowOpener('c.md') !== undefined, 'the first table');
	await showTable('notes');
	return fake;
}

function rowOpener(fileName: string) {
	const row = [...document.querySelectorAll('tr')].find((tr) =>
		tr.textContent?.includes(fileName),
	);
	return row?.querySelector<HTMLButtonElement>(
		'button[aria-label="Open row detail"]',
	);
}

async function openRow(fileName: string) {
	rowOpener(fileName)?.dispatchEvent(
		new MouseEvent('click', { bubbles: true }),
	);
	await until(() => bodyView() !== undefined, `the ${fileName} dialog`);
}

async function closeDialog() {
	click(document.body, 'Close');
	await until(() => bodyView() === undefined, 'the dialog to close');
}

async function showTable(name: 'notes' | 'ideas') {
	click(document.body, `Show ${name}`);
	const row = name === 'notes' ? 'a.md' : 'c.md';
	await until(() => rowOpener(row) !== undefined, `the ${name} grid`);
}

/** The mounted CodeMirror view, found from its content element. */
function bodyView() {
	const content = document.querySelector<HTMLElement>('.cm-content');
	return content ? (EditorView.findFromDOM(content) ?? undefined) : undefined;
}

function shownBody() {
	return bodyView()?.state.doc.toString();
}

/** Replace the document through a CodeMirror input transaction. */
function typeBody(text: string) {
	const view = bodyView();
	if (!view) throw new Error('No body editor is mounted');
	view.dispatch({
		changes: { from: 0, to: view.state.doc.length, insert: text },
		userEvent: 'input.type',
	});
	flushSync();
}

const bodyOnDisk = (text: string | undefined) =>
	text === undefined ? undefined : parseMarkdown(text).data?.body;

function pageText() {
	return document.body.textContent ?? '';
}

function unsavedText(fileName: string) {
	return document.querySelector<HTMLTextAreaElement>(
		`textarea[aria-label="Retained body of ${fileName}"]`,
	)?.value;
}

test('each change saves the whole body at once and keeps frontmatter another writer added', async () => {
	const fake = await setup();
	await openRow('a.md');
	expect(shownBody()).toBe('first body\n');

	// Another writer adds a field; no watcher batch has arrived yet.
	fake.notes.set('a.md', '---\ntitle: A\nstatus: done\n---\nfirst body\n');
	typeBody('# Hello\n');

	await until(() => fake.writes.length === 1, 'the write');
	expect(fake.notes.get('a.md')).toBe(
		'---\ntitle: A\nstatus: done\n---\n# Hello\n',
	);
	expect(pageText()).not.toContain('Saving');

	await closeDialog();
	await openRow('b.md');
	expect(shownBody()).toBe('second body\n');
	typeBody('for b');
	await until(() => fake.writes.length === 2, 'the second write');
	expect(fake.writes.map((write) => write.fileName)).toEqual(['a.md', 'b.md']);
	expect(bodyOnDisk(fake.notes.get('b.md'))).toBe('for b');

	await closeDialog();
	await openRow('a.md');
	expect(shownBody()).toBe('# Hello\n');
});

test('input during a write waits, only the newest is written next, and a late echo replaces nothing', async () => {
	const fake = await setup();
	await openRow('a.md');
	fake.control.hold = true;

	typeBody('one');
	await until(() => fake.heldWrites === 1, 'the first write to start');
	typeBody('two');
	typeBody('three');
	expect(pageText()).toContain('Saving…');

	fake.release();
	await until(() => fake.writes.length === 1, 'the first write');
	expect(shownBody()).toBe('three');
	await until(() => fake.heldWrites === 1, 'the second write to start');

	// The watcher's echo of the first write arrives while the second runs.
	fake.echo({
		kind: 'content',
		fileName: 'a.md',
		text: '---\ntitle: A\n---\none',
	});
	expect(shownBody()).toBe('three');

	fake.release();
	await until(() => fake.writes.length === 2, 'the second write');
	expect(fake.writes.map((write) => bodyOnDisk(write.content))).toEqual([
		'one',
		'three',
	]);

	// The same stale echo again, after the newest write landed.
	fake.echo({
		kind: 'content',
		fileName: 'a.md',
		text: '---\ntitle: A\n---\none',
	});
	expect(shownBody()).toBe('three');
	fake.echo({
		kind: 'content',
		fileName: 'a.md',
		text: fake.notes.get('a.md') ?? '',
	});
	expect(pageText()).not.toContain('Saving');
	expect(pageText()).not.toContain('The observed file body differs.');
});

test('a failed save keeps its text through closing the dialog and switching tables, and Try again saves it', async () => {
	const fake = await setup();
	await openRow('a.md');
	fake.control.failure = 'Disk is full';

	typeBody('kept text');
	await until(
		() => pageText().includes("Couldn't save the body of a.md"),
		'the failure',
	);
	expect(pageText()).toContain('Disk is full');
	expect(fake.notes.get('a.md')).toBe('---\ntitle: A\n---\nfirst body\n');

	await closeDialog();
	expect(unsavedText('a.md')).toBe('kept text');

	await showTable('ideas');
	expect(unsavedText('a.md')).toBeUndefined();
	await showTable('notes');
	expect(unsavedText('a.md')).toBe('kept text');

	await openRow('a.md');
	expect(shownBody()).toBe('kept text');

	fake.control.failure = undefined;
	click(document.body, 'Try again');
	await until(() => fake.writes.length === 1, 'the retried write');
	expect(fake.notes.get('a.md')).toBe('---\ntitle: A\n---\nkept text');
	expect(pageText()).not.toContain("Couldn't save");
	expect(unsavedText('a.md')).toBeUndefined();
});

test('a file removed elsewhere is not recreated, and its text stays in the pane after the dialog closes', async () => {
	const fake = await setup();
	await openRow('a.md');

	fake.notes.delete('a.md');
	typeBody('orphan text');
	await until(
		() => pageText().includes('The file no longer exists'),
		'the failure',
	);
	expect(fake.writes).toEqual([]);
	expect(fake.notes.has('a.md')).toBe(false);

	fake.echo({ kind: 'removed', fileName: 'a.md' });
	await until(() => bodyView() === undefined, 'the dialog to close');
	expect(unsavedText('a.md')).toBe('orphan text');
	expect(pageText()).toContain('The file no longer exists');

	click(document.body, 'Discard my text');
	flushSync();
	expect(unsavedText('a.md')).toBeUndefined();
	expect(fake.notes.has('a.md')).toBe(false);
});

test('malformed frontmatter refuses the save, keeps the bytes, and keeps the text', async () => {
	const fake = await setup();
	await openRow('a.md');

	const malformed = '---\ntitle: [unclosed\n---\nfirst body\n';
	fake.notes.set('a.md', malformed);
	typeBody('new text');
	await until(
		() => pageText().includes('Frontmatter is not valid YAML'),
		'the failure',
	);
	expect(fake.writes).toEqual([]);
	expect(fake.notes.get('a.md')).toBe(malformed);

	fake.echo({ kind: 'content', fileName: 'a.md', text: malformed });
	await until(() => bodyView() === undefined, 'the dialog to close');
	expect(unsavedText('a.md')).toBe('new text');
	expect(fake.notes.get('a.md')).toBe(malformed);
});

test("an untouched editor follows another writer; after typing, another writer's body waits for Discard my text", async () => {
	const fake = await setup();
	await openRow('a.md');

	fake.echo({
		kind: 'content',
		fileName: 'a.md',
		text: '---\ntitle: A\n---\nexternal',
	});
	expect(shownBody()).toBe('external');

	typeBody('mine');
	await until(() => fake.writes.length === 1, 'the write');

	fake.notes.set('a.md', '---\ntitle: A\n---\ntheirs');
	fake.echo({
		kind: 'content',
		fileName: 'a.md',
		text: '---\ntitle: A\n---\ntheirs',
	});
	expect(shownBody()).toBe('mine');
	expect(pageText()).toContain('The observed file body differs.');

	click(document.body, 'Discard my text');
	flushSync();
	expect(shownBody()).toBe('theirs');
	expect(pageText()).not.toContain('The observed file body differs.');
	expect(fake.writes).toHaveLength(1);
});

test('a saved retained body remains accessible after its file disappears', async () => {
	const fake = await setup();
	await openRow('a.md');
	typeBody('saved then removed');
	await until(() => fake.writes.length === 1, 'the save');
	fake.notes.delete('a.md');
	fake.echo({ kind: 'removed', fileName: 'a.md' });
	await until(() => bodyView() === undefined, 'the dialog to close');
	expect(unsavedText('a.md')).toBe('saved then removed');
	expect(pageText()).toContain('Your next edit replaces it.');
});

test('a retired body control cannot start another save or discard its accepted text', async () => {
	const fake = fakeVault();
	const { createTable } = await import('../../../../lib/table.svelte.ts');
	const table = createTable('/vault/notes', () => {});
	cleanup.push(() => {
		table.dispose();
		clearMocks();
	});
	await table.whenReady;
	const editor = table.bodyEditor('a.md');
	editor.set('accepted');
	await until(() => fake.writes.length === 1, 'the save');
	table.dispose();
	editor.set('late');
	editor.retry();
	editor.discard();
	await Promise.resolve();
	expect(editor.body).toBe('accepted');
	expect(fake.writes).toHaveLength(1);
});
