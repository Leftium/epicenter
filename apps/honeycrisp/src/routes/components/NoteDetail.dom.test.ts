/**
 * Note View Tests
 *
 * Mounts the real note view, `NoteDetail`, with its status bar, rich-text
 * editor, and UI library, over the real notes state and the production row
 * editor on the in-memory OPFS stand-in. Events are delivered to the DOM the
 * view renders; jsdom has no layout, focus, selection, or IME, so these show
 * what a delivered event does, not that a person can type there.
 *
 * Key behaviors:
 * - One mounted view, reused for note A, then B, then A, edits the note it
 *   shows at the moment of each event
 * - A control that outlives its view, or its tab, delivers input nothing takes
 * - Each conditional control has its own lifetime: after file view A, the
 *   fields, then file view B (and Source A, rich text, Source B), A takes
 *   nothing for good and B works
 * - Switching between rich text and Source, or typing a title, keeps the one
 *   rich-text view, so its focus and undo history stay
 * - Another program's change shows only on Reload file; with text not saved
 *   the person confirms first, and a reload that fails keeps the text
 * - A failed save keeps the text editable and offers Try again; typing
 *   afterwards saves again
 * - A save that finds no file offers Save as a note at once, with no reload,
 *   and a later save that lands clears the error and the offer
 * - A title the editor refuses stays in its control with the reason
 * - The file view shows LF and writes the file's own line endings back, and
 *   its control takes nothing once the fields show again
 * - Both status bars name an unconfirmed save in the folder's own words
 */
import '../../lib/dom.test-support.ts';
import { afterEach, expect, test } from 'bun:test';
import { buttonNamed, click, type } from '../../lib/dom.test-support.ts';
import {
	noteText,
	openNotesFolder,
	until,
} from '../../lib/folder.test-support.js';
import type { NoteSession } from '../../lib/notes.svelte.js';

const { flushSync, mount, unmount } = await import('svelte');
const { createNotes } = await import('../../lib/notes.svelte.ts');
const { switchable } = await import('../../lib/effects.test-support.svelte.ts');
const { default: NoteDetail } = await import('./NoteDetail.svelte');
const { default: DraftStatus } = await import('./DraftStatus.svelte');
const { default: Host } = await import('../../lib/ui-host.test-support.svelte');

/** Mount `component` as the page renders it, with `props` read when it reads them. */
function render(component: unknown, props: Record<string, unknown>) {
	const target = document.createElement('div');
	document.body.append(target);
	const host = mount(Host, {
		target,
		props: { component: component as never, props },
	});
	flushSync();
	let mounted = true;
	const close = () => {
		if (!mounted) return;
		mounted = false;
		unmount(host);
		flushSync();
	};
	cleanup.push(() => {
		close();
		target.remove();
	});
	return { target, close };
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});

/** Two notes open in the notes state, and one view showing the first. */
async function view() {
	const fixture = await openNotesFolder();
	const notes = createNotes(fixture.host);
	cleanup.push(() => notes.close());
	await fixture.write('notes/a.md', noteText({ title: 'Alpha' }));
	await fixture.write('notes/b.md', noteText({ title: 'Beta' }));
	await notes.refreshAll();
	const opened = async (path: string) => {
		await notes.open(path);
		const session = notes.noteAt(path);
		if (session === undefined) throw new Error(`${path} did not open`);
		return session;
	};
	const a = await opened('notes/a.md');
	const b = await opened('notes/b.md');
	const shown = switchable(a);
	const { target, close } = render(NoteDetail, {
		notes,
		get session() {
			return shown.value;
		},
	});
	return { ...fixture, notes, a, b, opened, shown, target, close };
}

const titleOf = (session: NoteSession) =>
	session.row.status === 'valid' ? session.row.fields.title : undefined;

/** Let a binding's after-input check run, then render. */
async function tick() {
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
}

test('one reused view edits the note it shows at each event: A, then B, then A', async () => {
	const { a, b, shown, target } = await view();
	const title = target.querySelector<HTMLInputElement>(
		'input[aria-label="Title"]',
	);
	if (title === null) throw new Error('No title control');
	expect(title.value).toBe('Alpha');

	shown.value = b;
	flushSync();
	// The same control, now showing B.
	expect(target.querySelector('input[aria-label="Title"]')).toBe(title);
	expect(title.value).toBe('Beta');
	const alpha = a.row.text;
	type(title, 'Beta typed');
	flushSync();
	expect(titleOf(b)).toBe('Beta typed');
	expect(a.row.text).toBe(alpha);

	shown.value = a;
	flushSync();
	expect(title.value).toBe('Alpha');
	type(title, 'Alpha typed');
	flushSync();
	expect(titleOf(a)).toBe('Alpha typed');
	expect(titleOf(b)).toBe('Beta typed');
});

test('a control that outlives its view or its tab delivers input that nothing takes', async () => {
	const { a, target, close } = await view();
	const before = a.row.text;
	click(target, 'Source');
	flushSync();
	const source = target.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label="Markdown source"]',
	);
	if (source === null) throw new Error('No Source view');
	expect(source.value).toBe('Body.\n');
	click(target, 'Rich text');
	flushSync();
	expect(source.isConnected).toBe(false);
	// The Source tab is gone; its retained control still delivers input.
	type(source, 'Typed into a tab that is gone\n');
	flushSync();
	expect(a.row.text).toBe(before);

	const title = target.querySelector<HTMLInputElement>(
		'input[aria-label="Title"]',
	);
	close();
	type(title, 'Typed into a view that is gone');
	expect(a.row.text).toBe(before);
	expect(a.save.status).toBe('idle');
});

/** The one control matching `selector`, or a failure naming it. */
function only<T extends Element>(target: ParentNode, selector: string): T {
	const found = target.querySelector<T>(selector);
	if (found === null) throw new Error(`Nothing matches ${selector}`);
	return found;
}

test('a file view that is gone takes nothing for good, after the fields and a new file view show', async () => {
	const { a, target } = await view();
	click(target, 'Edit as file');
	flushSync();
	const fileA = only<HTMLTextAreaElement>(
		target,
		'textarea[aria-label^="Contents of"]',
	);
	click(target, 'Open as note');
	flushSync();
	click(target, 'Edit as file');
	flushSync();
	const fileB = only<HTMLTextAreaElement>(
		target,
		'textarea[aria-label^="Contents of"]',
	);
	expect(fileB).not.toBe(fileA);
	// The same view, mode, and session as when A was live: A still takes nothing.
	const before = a.row.text;
	type(fileA, 'from the old file view');
	flushSync();
	expect(a.row.text).toBe(before);
	type(fileB, fileB.value.replace('Body.', 'From the new one.'));
	flushSync();
	expect(a.row.text).toContain('From the new one.');
});

test('a Source view that is gone takes nothing for good, after rich text and a new Source view show', async () => {
	const { a, target } = await view();
	click(target, 'Source');
	flushSync();
	const sourceA = only<HTMLTextAreaElement>(
		target,
		'textarea[aria-label="Markdown source"]',
	);
	click(target, 'Rich text');
	flushSync();
	click(target, 'Source');
	flushSync();
	const sourceB = only<HTMLTextAreaElement>(
		target,
		'textarea[aria-label="Markdown source"]',
	);
	expect(sourceB).not.toBe(sourceA);
	const before = a.row.text;
	type(sourceA, 'From the old Source\n');
	flushSync();
	expect(a.row.text).toBe(before);
	type(sourceB, 'From the new Source\n');
	flushSync();
	expect(a.row).toMatchObject({ body: 'From the new Source\n' });
});

test('switching between rich text and Source, or typing a title, keeps the one rich-text view', async () => {
	const { a, target } = await view();
	const rich = only<HTMLElement>(target, '[aria-label="Note text"]');
	click(target, 'Source');
	flushSync();
	click(target, 'Rich text');
	flushSync();
	expect(only(target, '[aria-label="Note text"]')).toBe(rich);
	type(only<HTMLInputElement>(target, 'input[aria-label="Title"]'), 'Retitled');
	await tick();
	expect(titleOf(a)).toBe('Retitled');
	expect(only(target, '[aria-label="Note text"]')).toBe(rich);
	await a.waitForSaves();
	flushSync();
	expect(rich.isConnected).toBe(true);
});

test('another program’s change shows only on Reload file, and with text not saved the person confirms first', async () => {
	const { a, target, put, failWrites } = await view();
	const title = only<HTMLInputElement>(target, 'input[aria-label="Title"]');
	put('notes/a.md', noteText({ title: 'Outside' }));
	await tick();
	expect(title.value).toBe('Alpha');
	click(target, 'Reload file');
	await until(() => titleOf(a) === 'Outside', 'the reload');
	flushSync();
	expect(title.value).toBe('Outside');

	failWrites();
	type(title, 'Mine');
	await a.waitForSaves();
	await tick();
	click(target, 'Reload file');
	flushSync();
	// The text is not saved: nothing is read until the person confirms.
	expect(target.textContent).toContain('your text that is not saved is lost');
	click(target, 'Keep my text');
	flushSync();
	expect(buttonNamed(target, 'Reload and lose my text')).toBeUndefined();
	expect(titleOf(a)).toBe('Mine');

	// A reload that cannot read the file keeps the text and its failed save.
	put('notes/a.md', new Uint8Array([0xff]));
	click(target, 'Reload file');
	flushSync();
	click(target, 'Reload and lose my text');
	await until(() => a.reloadError !== undefined, 'the failed reload');
	flushSync();
	expect(titleOf(a)).toBe('Mine');
	expect(title.value).toBe('Mine');
	expect(a.save.status).toBe('failed');
	expect(target.textContent).toContain('Your text is unchanged');
});

test('a failed save stays visible during a held later edit, and its successful save clears the error', async () => {
	const { a, target, failWrites, text, hold, held, release } = await view();
	const title = only<HTMLInputElement>(target, 'input[aria-label="Title"]');
	const status = only(target, '[data-testid="draft-status"]');
	failWrites();
	type(title, 'First');
	await a.waitForSaves();
	await tick();
	expect(status.getAttribute('data-status')).toBe('failed');
	expect(buttonNamed(target, 'Try again')).toBeDefined();
	failWrites(false);
	hold();
	type(title, 'Second');
	try {
		await until(() => held().length === 1, 'the later write to be held');
		await tick();
		expect(status.getAttribute('data-status')).toBe('saving');
		expect(status.textContent).toContain('Not saved');
		expect(status.textContent).toContain('Saving');
		expect(title.value).toBe('Second');
		expect(title.disabled).toBe(false);
	} finally {
		release({ all: true });
	}
	expect((await a.waitForSaves()).error).toBeNull();
	flushSync();
	expect(text('notes/a.md')).toContain('"title": "Second"');
	expect(status.getAttribute('data-status')).toBe('saved');
	expect(status.textContent).not.toContain('Not saved');
});

test('a save that finds no file offers Save as a note at once and keeps the text editable; a later save that lands clears both', async () => {
	const { a, target, drop, put, text } = await view();
	const title = only<HTMLInputElement>(target, 'input[aria-label="Title"]');
	const status = only(target, '[data-testid="draft-status"]');
	expect(buttonNamed(target, 'Save as a note')).toBeUndefined();
	drop('notes/a.md');
	type(title, 'Kept');
	expect((await a.waitForSaves()).error?.name).toBe('NotFound');
	await tick();
	// The failed save alone offers it: no reload ran and no path change is tracked.
	expect(a.reloadError).toBeUndefined();
	expect(a.pathChange).toBeUndefined();
	expect(status.getAttribute('data-status')).toBe('failed');
	expect(status.textContent).toContain('saving does not create it again');
	expect(buttonNamed(target, 'Save as a note')).toBeDefined();
	expect(title.value).toBe('Kept');
	expect(title.disabled).toBe(false);

	// Another program puts the file back, and the next edit saves over it.
	put('notes/a.md', noteText({ title: 'Outside' }));
	type(title, 'Kept again');
	expect((await a.waitForSaves()).error).toBeNull();
	await tick();
	expect(text('notes/a.md')).toContain('"title": "Kept again"');
	expect(status.getAttribute('data-status')).toBe('saved');
	expect(status.textContent).not.toContain('Not saved');
	expect(buttonNamed(target, 'Save as a note')).toBeUndefined();
});

test('a title the editor refuses stays in its control with the reason', async () => {
	const { a, target } = await view();
	const title = only<HTMLInputElement>(target, 'input[aria-label="Title"]');
	const before = a.row.text;
	type(title, 'Half \uD800');
	await tick();
	// The binding checks its getter after input: the typed value is what it reads.
	expect(title.value).toBe('Half \uD800');
	expect(a.row.text).toBe(before);
	expect(target.textContent).toContain(
		'what you typed in the title cannot be written',
	);
	type(title, 'Whole');
	await tick();
	expect(titleOf(a)).toBe('Whole');
	expect(target.textContent).not.toContain('cannot be written');
});

test('the file view shows LF, writes the file’s own line endings, and its control takes nothing once the fields show again', async () => {
	const { opened, shown, target, write, text } = await view();
	const crlf = noteText({ title: 'Lines' }).replace(/\n/g, '\r\n');
	await write('notes/c.md', crlf);
	const c = await opened('notes/c.md');
	shown.value = c;
	flushSync();
	click(target, 'Edit as file');
	flushSync();
	const file = target.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label="Contents of notes/c.md"]',
	);
	if (file === null) throw new Error('No file view');
	expect(file.value).toBe(crlf.replace(/\r\n/g, '\n'));
	type(file, file.value.replace('Body.', 'Body typed.'));
	flushSync();
	expect(c.row.text).toBe(crlf.replace('Body.', 'Body typed.'));
	expect((await c.waitForSaves()).error).toBeNull();
	expect(text('notes/c.md')).toBe(crlf.replace('Body.', 'Body typed.'));

	click(target, 'Open as note');
	flushSync();
	expect(file.isConnected).toBe(false);
	type(file, 'not a note any more');
	flushSync();
	expect(c.row.text).toBe(crlf.replace('Body.', 'Body typed.'));
	expect(c.rawMode).toBe(false);
});

test('the note status names an unconfirmed save in the folder’s own words', async () => {
	const { a, target, loseReplies } = await view();
	const title = target.querySelector<HTMLInputElement>(
		'input[aria-label="Title"]',
	);
	loseReplies();
	type(title, 'Maybe saved');
	await a.waitForSaves();
	flushSync();
	const { save } = a;
	if (save.status !== 'failed') throw new Error('Expected a stopped save');
	const status = target.querySelector('[data-testid="draft-status"]');
	expect(status?.getAttribute('data-status')).toBe('unconfirmed');
	expect(status?.textContent).toContain(save.error.message);
	expect(status?.textContent).toContain('may or may not');
	expect(buttonNamed(target, 'Save again')).toBeDefined();
});

test('the text file status names an unconfirmed save in the folder’s own words', async () => {
	const { notes, write, loseReplies } = await view();
	await write('docs/plain.txt', 'plain\n');
	await notes.refresh();
	await notes.open('docs/plain.txt');
	const session = notes.sessionAt('docs/plain.txt');
	if (session === undefined) throw new Error('The text file did not open');
	loseReplies();
	session.input('changed\n');
	await session.save();
	const attempt = session.attempt;
	if (attempt?.state !== 'unconfirmed')
		throw new Error('Expected an unconfirmed save');
	const { target } = render(DraftStatus, {
		session,
		onRecover: async () => undefined,
		onDiscard: () => {},
		onStopTracking: () => {},
	});
	await until(
		() => target.textContent?.includes('not confirmed') ?? false,
		'the status',
	);
	expect(target.textContent).toContain(attempt.problem);
});
