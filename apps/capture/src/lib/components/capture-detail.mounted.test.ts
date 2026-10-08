/**
 * Mounted Capture Detail Tests
 *
 * The real `CaptureDetail` component, compiled for the client and mounted in
 * jsdom, over real drafts and the folder's real row editors on a directory in
 * a temporary directory. Events are dispatched on the component's own
 * elements, as a keystroke would deliver them.
 *
 * Key behaviors:
 * - Each binding writes to the draft the view has at the call: a view kept
 *   mounted while its draft changes A, B, A writes each to its own file
 * - A control that outlives its view delivers nothing after the view is
 *   destroyed
 * - A capture whose editor could not open says why and shows no text box
 * - Source shows LF lines and saves exactly, keeping the file's CRLF lines
 * - A fenced capture takes nothing from its controls
 * - Each text box has its own lifetime: one whose block went away writes
 *   nothing, even after the view makes a new one (Source-only then fields
 *   again), and a thought's editor writes only to that thought's edit
 * - The deletion review outlives the view, and while leaving it deletes
 *   nothing
 *
 * jsdom has no layout, focus, selection, or IME; these tests say what a
 * delivered event does, not that a person can type there.
 */

import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDefinition } from '@epicenter/capture';
import { openFolder } from '@epicenter/folder/bun';
import { flushSync, mount, unmount } from 'svelte';
import { expectOk } from 'wellcrafted/testing';
import type { Draft } from '../draft.svelte.ts';
import {
	button,
	click,
	field,
	submit,
	type,
} from '../svelte-dom.test-support.js';

const { createCaptures } = await import('../captures.svelte.ts');
const { switchable } = await import('../switchable.test-support.svelte.ts');
const { default: CaptureDetail } = await import('./CaptureDetail.svelte');

const roots: string[] = [];
afterAll(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

const AT = '2026-10-04T20:49:23.041Z';
const fileOf = (text: string, newline = '\n') =>
	[`---`, `capturedAt: ${AT}`, `---`, ``, text, ``, `## Thoughts`, ``].join(
		newline,
	);
const canonical = (text: string) =>
	`---\n"capturedAt": "${AT}"\n---\n\n${text}\n\n## Thoughts\n`;

async function setup(sources: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), 'capture-mounted-'));
	roots.push(root);
	await mkdir(join(root, 'captures'));
	for (const [stem, source] of Object.entries(sources))
		await writeFile(join(root, 'captures', `${stem}.md`), source);
	const folder = expectOk(
		await openFolder({
			root,
			definition: captureDefinition,
			git: {
				author: { name: 'Test', email: 'test@localhost' },
				commitOnEdit: false,
			},
		}),
	);
	const captures = createCaptures({ folder, location: folder.location });
	await captures.refresh();
	async function open(stem: string): Promise<Draft> {
		const draft = captures.open(stem);
		if (!draft) throw new Error(`no draft for ${stem}`);
		await draft.ready;
		return draft;
	}
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	return {
		captures,
		open,
		target,
		disk: (stem: string) =>
			readFile(join(root, 'captures', `${stem}.md`), 'utf8'),
		write: (stem: string, source: string | Uint8Array) =>
			writeFile(join(root, 'captures', `${stem}.md`), source),
		/** Mount the view over `draft`; `show.value` changes the draft it is given. */
		mount(draft: Draft) {
			const show = switchable(draft);
			const view = mount(CaptureDetail, {
				target,
				props: {
					get draft() {
						return show.value;
					},
					captures,
					get stem() {
						return show.value.stem;
					},
					onBack() {},
					onDeleted() {},
					onOpen() {},
				},
			});
			flushSync();
			return { show, view };
		},
		async done() {
			await captures.close();
			await folder.close();
		},
	};
}

test('rejected capture text restores the mounted field and Source can complete the Markdown', async () => {
	const t = await setup({ a: fileOf('A') });
	const draft = await t.open('a');
	const { view } = t.mount(draft);
	const text = field('capture-text');
	type(text, 'A\n```\nopen');
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
	expect(text?.value).toBe('A');
	expect(draft.unsettled).toBe(false);
	expect(document.body.textContent).toContain('Use Source to write unfinished Markdown');
	draft.setView('source');
	flushSync();
	const source = field('capture-source');
	const unfinished = draft.source.replace('\nA\n', '\nA\n```\nopen\n');
	type(source, unfinished);
	await draft.settle();
	expect(await t.disk('a')).toBe(unfinished);
	type(source, unfinished.replace('\nopen\n', '\nopen\n```\n'));
	await draft.settle();
	expect(draft.document.text).toBe('A\n```\nopen\n```');
	await unmount(view);
	await t.done();
});

test('a view kept mounted while its draft changes A, B, A writes each edit to the draft it has then', async () => {
	const t = await setup({ a: fileOf('A'), b: fileOf('B') });
	const a = await t.open('a');
	const b = await t.open('b');
	const { show, view } = t.mount(a);
	const box = field('capture-text');
	expect(box?.value).toBe('A');

	type(box, 'A, typed');
	show.value = b;
	flushSync();
	// The same element, now showing B.
	expect(field('capture-text')).toBe(box);
	expect(box?.value).toBe('B');
	type(box, 'B, typed');
	show.value = a;
	flushSync();
	expect(field('capture-text')).toBe(box);
	expect(box?.value).toBe('A, typed');
	type(box, 'A, typed again');

	await t.captures.departure.settle();
	expect(await t.disk('a')).toBe(canonical('A, typed again'));
	expect(await t.disk('b')).toBe(canonical('B, typed'));
	unmount(view);
	await t.done();
});

test('a control that outlives its view delivers nothing once the view is destroyed', async () => {
	const t = await setup({ one: fileOf('Kept') });
	const draft = await t.open('one');
	const { view } = t.mount(draft);
	const box = field('capture-text');
	const thought = field('new-thought');
	type(thought, 'typed while mounted');
	expect(draft.newThought).toBe('typed while mounted');

	unmount(view);
	flushSync();
	// Svelte leaves the binding's listener on the element something still holds.
	type(box, 'delivered after destroy');
	type(thought, 'delivered after destroy');
	expect(draft.text).toBe('Kept');
	expect(draft.newThought).toBe('typed while mounted');
	await draft.settle();
	expect(await t.disk('one')).toBe(fileOf('Kept'));
	await t.done();
});

test('a capture whose editor could not open says why and shows no text box', async () => {
	const t = await setup({ one: fileOf('Before') });
	await t.write('one', new Uint8Array([0xff, 0xfe, 0x00]));
	const draft = await t.open('one');
	expect(draft.loaded).toBe(false);
	const { view } = t.mount(draft);

	expect(
		t.target.querySelector('[aria-label="File unavailable"]')?.textContent,
	).toContain('cannot be read');
	expect(t.target.querySelector('textarea')).toBeNull();
	draft.setView('source');
	flushSync();
	expect(t.target.querySelector('textarea')).toBeNull();
	unmount(view);
	await t.done();
});

test("Source shows LF lines, and a body edit there keeps the file's CRLF lines", async () => {
	const crlf = fileOf('First line\r\nSecond line', '\r\n');
	const t = await setup({ one: crlf });
	const draft = await t.open('one');
	draft.setView('source');
	const { view } = t.mount(draft);
	const source = field('capture-source');
	expect(source?.value).toBe(crlf.replaceAll('\r\n', '\n'));

	type(
		source,
		source?.value.replace('Second line', 'Second line, edited') ?? '',
	);
	await draft.settle();
	// Source saves exactly: every line keeps its CRLF.
	expect(JSON.stringify(await t.disk('one'))).toBe(
		JSON.stringify(crlf.replace('Second line', 'Second line, edited')),
	);
	unmount(view);
	await t.done();
});

test('a fenced capture takes nothing from its controls', async () => {
	const t = await setup({ one: fileOf('Kept') });
	const draft = await t.open('one');
	const { view } = t.mount(draft);
	t.captures.departure.fence();
	flushSync();
	const box = field('capture-text');
	expect(box?.readOnly).toBe(true);
	type(box, 'typed while fenced');
	type(field('new-thought'), 'typed while fenced');
	expect(draft.text).toBe('Kept');
	expect(draft.newThought).toBe('');

	t.captures.departure.resume();
	flushSync();
	expect(box?.readOnly).toBe(false);
	type(box, 'typed after');
	expect(draft.text).toBe('typed after');
	unmount(view);
	await t.done();
});

test('text boxes whose block went away write nothing after Source broke the file and repaired it', async () => {
	const t = await setup({ one: fileOf('Before') });
	const draft = await t.open('one');
	const { view } = t.mount(draft);
	const oldText = field('capture-text');
	const oldThought = field('new-thought');
	draft.setView('source');
	flushSync();
	const source = field('capture-source');
	type(source, fileOf('Before').replace(`capturedAt: ${AT}`, 'capturedAt: ['));
	flushSync();
	expect(draft.status).toBe('invalid');
	type(source, fileOf('Back'));
	draft.setView('capture');
	flushSync();
	const box = field('capture-text');
	expect(box).not.toBeNull();
	expect(box).not.toBe(oldText);
	expect(box?.value).toBe('Back');

	// The same view is eligible again; the old boxes are not.
	type(oldText, 'from the old box');
	type(oldThought, 'from the old box');
	expect(draft.text).toBe('Back');
	expect(draft.newThought).toBe('');
	type(box, 'from the new box');
	expect(draft.text).toBe('from the new box');
	await draft.settle();
	expect(await t.disk('one')).toBe(canonical('from the new box'));
	unmount(view);
	await t.done();
});

test("a thought's edit form acts only for its own edit: once gone, its text box, Save, and Cancel reach nothing, even when the same thought is edited again", async () => {
	const withThoughts = fileOf('Text').replace(
		'## Thoughts\n',
		'## Thoughts\n\n- first\n- second\n',
	);
	const t = await setup({ one: withThoughts });
	const draft = await t.open('one');
	const { view } = t.mount(draft);
	const [first, second] = draft.document.thoughts;
	if (!first || !second) throw new Error('fixture');

	const editor = () =>
		t.target.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="Thought text"]',
		);
	/** The open edit's form, through its own Cancel button. */
	const cancelIn = (form: Element | null | undefined) => {
		const cancel = [...(form?.querySelectorAll('button') ?? [])].find(
			(candidate) => candidate.textContent?.trim() === 'Cancel',
		);
		if (cancel === undefined) throw new Error('no Cancel');
		click(cancel);
	};

	draft.startEditing(0);
	flushSync();
	const editorA = editor();
	const formA = editorA?.closest('form');
	expect(editorA?.value).toBe('first');
	type(editorA, 'first, edited');
	expect(draft.editing?.text).toBe('first, edited');

	cancelIn(formA);
	draft.startEditing(1);
	flushSync();
	const editorB = editor();
	expect(editorB).not.toBe(editorA);
	expect(editorB?.value).toBe('second');
	type(editorB, 'second, typed');

	// A's detached form reaches nothing: not B's text, not B's Save.
	type(editorA, 'A, delivered late');
	submit(formA);
	cancelIn(formA);
	expect(draft.editing?.index).toBe(1);
	expect(draft.editing?.text).toBe('second, typed');
	expect(draft.document.thoughts).toEqual(['first', 'second']);
	expect(draft.saving).toBe(false);

	// The same thought opened again is a new edit with a new form; A's old
	// form still reaches nothing.
	cancelIn(editorB?.closest('form'));
	const [firstAgain] = draft.document.thoughts;
	if (!firstAgain) throw new Error('fixture');
	draft.startEditing(0);
	flushSync();
	const editorA2 = editor();
	const formA2 = editorA2?.closest('form');
	expect(formA2).not.toBe(formA);
	type(editorA2, 'first, again');
	submit(formA);
	type(editorA, 'A, delivered late again');
	expect(draft.editing?.text).toBe('first, again');
	expect(draft.saving).toBe(false);

	// The live form saves its own edit, of the draft it has now.
	submit(formA2);
	flushSync();
	expect(draft.editing).toBeUndefined();
	expect(draft.document.thoughts).toEqual(['first, again', 'second']);
	// Submitted at once: the save is already on its way.
	expect(draft.saving).toBe(true);
	unmount(view);
	await t.done();
});

test('the deletion review outlives the view, and while leaving it deletes nothing', async () => {
	const t = await setup({ one: fileOf('To delete') });
	const draft = await t.open('one');
	const first = t.mount(draft);
	await t.captures.reviewDeletion(draft);
	flushSync();
	expect(document.querySelector('[aria-label="Saved file"]')?.textContent).toBe(
		fileOf('To delete'),
	);

	// The view goes, as when the selection changes; the review stays held.
	unmount(first.view);
	flushSync();
	expect(draft.deletionReview?.entry.text).toBe(fileOf('To delete'));
	expect(draft.operation).toBe('deleting');
	const second = t.mount(draft);
	expect(document.querySelector('[aria-label="Saved file"]')?.textContent).toBe(
		fileOf('To delete'),
	);

	t.captures.departure.fence();
	flushSync();
	const remove = button('Permanently delete');
	expect(remove.disabled).toBe(true);
	click(remove);
	expect(await t.captures.remove(draft)).toBe(false);
	expect(await t.disk('one')).toBe(fileOf('To delete'));
	expect(draft.retired).toBe(false);

	t.captures.departure.resume();
	flushSync();
	expect(button('Permanently delete').disabled).toBe(false);
	click(button('Cancel'));
	flushSync();
	expect(draft.deletionReview).toBeUndefined();
	expect(draft.admitted).toBe(true);
	unmount(second.view);
	await t.done();
});

test('invalid input opens Source, repair stays there, and tab changes retire the old controls', async () => {
	const t = await setup({ one: fileOf('Kept') });
	const draft = await t.open('one');
	const { view } = t.mount(draft);
	const capture = field('capture-text');
	draft.inputSource('broken');
	flushSync();
	expect(draft.view).toBe('source');
	expect(button('Capture').disabled).toBe(true);
	expect(field('capture-text')).toBeNull();
	const source = field('capture-source');
	expect(source?.value).toBe('broken');
	type(capture, 'late capture');
	expect(draft.source).toBe('broken');
	type(source, fileOf('Repaired'));
	flushSync();
	expect(draft.view).toBe('source');
	expect(button('Capture').disabled).toBe(false);
	click(button('Capture'));
	flushSync();
	expect(field('capture-source')).toBeNull();
	expect(field('capture-text')?.value).toBe('Repaired');
	type(source, 'late source');
	expect(draft.text).toBe('Repaired');
	unmount(view);
	await t.done();
});
