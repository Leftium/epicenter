/**
 * Row views, mounted.
 *
 * The real library over a real directory (the Bun opener), and the real
 * FileView, RecordingDetail, and TransformationDetail components mounted in
 * jsdom inside a fixture that renders them as the recordings and
 * transformations pages do. FileView is one component instance for every
 * selected transcript, so its bindings must reach the editor of the path it
 * shows now.
 *
 * Key behaviors:
 * - typing in a reused view lands in the editor of the path it shows now,
 *   across A, B, and A again, in the same textarea, and is the editor's row
 *   at once
 * - a control kept after its view is gone, or after the component is
 *   destroyed, changes nothing; nor does one from an earlier mode after that
 *   mode returns
 * - after a failed save the typing stays on screen and editable; later typing
 *   saves again, and Discard loads the file into the same editor and view
 * - another program's change is shown only after Reload from file
 * - a transcript or an ordinary file being renamed shows read-only, input
 *   delivered meanwhile is replaced on screen by what the draft holds, and a
 *   refused rename makes the same control editable again
 * - a transformation's title and source are one editor, and its Source
 *   preference outlives the view
 *
 * jsdom has no layout, focus, selection, or IME; see svelte-dom.test-support.
 */

import { afterEach, expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import type { Library } from '../../lib/library.svelte.js';
import { editingOf, untyped } from '../../lib/row-slot.test-support.js';
import { click, type } from '../svelte-dom.test-support.js';

// Load the workspace after the mounted loader registered its plugin.
const { openTestWorkspace } = await import(
	'../../lib/workspace.test-support.js'
);
const { flushSync, mount, tick, unmount } = await import('svelte');
const { createLibrary } = await import('../../lib/library.svelte.js');
const { pageState } = await import('../page-state.test-support.svelte.js');
const Host = (await import('./test-fixtures/SelectionHost.svelte')).default;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	document.body.replaceChildren();
});

const transcript = (body: string) =>
	`---\nrecordingId: one\ncreatedAt: 2026-10-01T00:00:00.000Z\nmodel: m\nendpoint: http://127.0.0.1:18080/v1\n---\n${body}`;
const A = 'transcriptions/a.md';
const B = 'transcriptions/b.md';
const RECIPE = 'transformations/clean.md';

/** A library over files on disk, mounted in the fixture with `tab` showing. */
async function open(
	files: Record<string, string>,
	tab: 'recordings' | 'transformations' = 'recordings',
) {
	const stubs = await openTestWorkspace();
	for (const [path, text] of Object.entries(files)) {
		await Bun.write(join(stubs.root, path), text);
	}
	/** Run before the folder's next move, if a test sets it. */
	const hooks: { beforeMove?: () => Promise<void> } = {};
	const { folder } = stubs.workspace;
	const library = createLibrary({
		...stubs.workspace,
		folder: {
			...folder,
			files: {
				...folder.files,
				async move(...args: Parameters<typeof folder.files.move>) {
					const before = hooks.beforeMove;
					hooks.beforeMove = undefined;
					await before?.();
					return folder.files.move(...args);
				},
			},
		},
	});
	await library.start();
	const page = pageState({ shown: true, tab });
	const target = document.createElement('main');
	document.body.append(target);
	const host = mount(Host, { target, props: { library, page } });
	let mounted = true;
	cleanups.push(async () => {
		if (mounted) unmount(host);
		await library.close();
		await stubs.remove();
	});
	return {
		library,
		page,
		target,
		root: stubs.root,
		/** Hold the folder's next move until `release`; `reached` once it is asked for. */
		holdMove() {
			const reached = Promise.withResolvers<void>();
			const held = Promise.withResolvers<void>();
			hooks.beforeMove = () => {
				reached.resolve();
				return held.promise;
			};
			return { reached: reached.promise, release: () => held.resolve() };
		},
		unmountHost() {
			mounted = false;
			unmount(host);
		},
	};
}

/** Select a file and let the views render it. */
async function show(library: Library, path: string) {
	await library.open(path);
	flushSync();
}

const editorAt = (library: Library, path: string) =>
	untyped(editingOf(library.transcriptAt(path)));

const bodyField = (target: ParentNode, name: string) =>
	target.querySelector<HTMLTextAreaElement>(
		`textarea[aria-label="Contents of ${name}"]`,
	);

const saveState = (target: ParentNode) =>
	target.querySelector('[data-save-state]')?.getAttribute('data-save-state');

test('typing in the one file view lands in the editor of the path it shows now, across A, B, and A again', async () => {
	const { library, target, root } = await open({
		[A]: transcript('Alpha.\n'),
		[B]: transcript('Beta.\n'),
	});
	// Both editors are open already, so a selection change swaps the editor
	// under the same rendered textarea rather than showing an opening in between.
	await library.openTranscript(A);
	await library.openTranscript(B);

	await show(library, A);
	const field = bodyField(target, 'a.md');
	expect(field?.value).toBe('Alpha.\n');
	type(field, 'Alpha, typed.\n');

	await show(library, B);
	// The same component and the same textarea now show B.
	expect(bodyField(target, 'b.md')).toBe(field);
	expect(field?.value).toBe('Beta.\n');
	type(field, 'Beta, typed.\n');

	await show(library, A);
	expect(bodyField(target, 'a.md')).toBe(field);
	expect(field?.value).toBe('Alpha, typed.\n');
	type(field, 'Alpha, typed again.\n');

	const a = editorAt(library, A);
	const b = editorAt(library, B);
	expect(a.row).toMatchObject({
		body: 'Alpha, typed again.\n',
		fields: { recordingId: 'one' },
	});
	expect(b.row).toMatchObject({ body: 'Beta, typed.\n' });
	expectOk(await a.waitForSaves());
	expectOk(await b.waitForSaves());
	expect(await readFile(join(root, A), 'utf8')).toBe(a.row.text);
	expect(await readFile(join(root, B), 'utf8')).toBe(b.row.text);
});

test('the whole-file source of a reused view edits the path it shows now, and its metadata goes with it', async () => {
	const { library, target, root } = await open({
		[A]: transcript('Alpha.\n'),
		[B]: transcript('Beta.\n'),
	});
	await show(library, A);
	click(target, 'Edit the whole file');
	flushSync();
	const source = bodyField(target, 'a.md');
	expect(source?.value).toBe(transcript('Alpha.\n'));

	await show(library, B);
	click(target, 'Edit the whole file');
	flushSync();
	expect(bodyField(target, 'b.md')?.value).toBe(transcript('Beta.\n'));
	type(
		bodyField(target, 'b.md'),
		transcript('Beta, as text.\n').replace('model: m', 'model: n'),
	);
	expectOk(await editorAt(library, B).waitForSaves());

	expect(await readFile(join(root, B), 'utf8')).toBe(
		transcript('Beta, as text.\n').replace('model: m', 'model: n'),
	);
	expect(await readFile(join(root, A), 'utf8')).toBe(transcript('Alpha.\n'));
	expect(editorAt(library, A).source).toBe(true);
});

test('a control kept after its view is gone, or after the component is destroyed, changes nothing', async () => {
	const { library, page, target, unmountHost } = await open({
		[A]: transcript('Alpha.\n'),
	});
	await show(library, A);
	const field = bodyField(target, 'a.md');
	const edit = [...target.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === 'Edit the whole file',
	);
	const editor = editorAt(library, A);

	// Closing the details unmounts the view; the editor is the library's.
	page.shown = false;
	flushSync();
	expect(field?.isConnected).toBe(false);
	type(field, 'Typed into a detached field.\n');
	edit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	expect(editor.row).toMatchObject({ body: 'Alpha.\n' });
	expect(editor.source).toBe(false);

	// Shown again: a new view, and typing there lands.
	page.shown = true;
	flushSync();
	const again = bodyField(target, 'a.md');
	expect(again).not.toBe(field);
	type(again, 'Typed in the new view.\n');
	expect(editor.row).toMatchObject({ body: 'Typed in the new view.\n' });

	// The whole component destroyed: its controls deliver nothing either.
	unmountHost();
	type(again, 'Typed after it was destroyed.\n');
	expect(editor.row).toMatchObject({ body: 'Typed in the new view.\n' });
	expectOk(await editor.waitForSaves());
});

test('after a failed save later typing saves again, and Discard loads the file into the same view', async () => {
	const { library, target, root } = await open({ [A]: transcript('Alpha.\n') });
	await show(library, A);
	const field = bodyField(target, 'a.md');
	const editor = editorAt(library, A);

	chmodSync(join(root, 'transcriptions'), 0o555);
	try {
		type(field, 'Typed before it failed.\n');
		expect((await editor.waitForSaves()).error).not.toBeNull();
		flushSync();
		expect(saveState(target)).toBe('failed');
		// The view stays, with the typing, and takes more of it.
		expect(bodyField(target, 'a.md')).toBe(field);
		expect(field?.value).toBe('Typed before it failed.\n');
	} finally {
		chmodSync(join(root, 'transcriptions'), 0o755);
	}

	type(field, 'Typed after it failed.\n');
	expect(editor.row).toMatchObject({ body: 'Typed after it failed.\n' });
	expectOk(await editor.waitForSaves());
	flushSync();
	expect(await readFile(join(root, A), 'utf8')).toContain(
		'Typed after it failed.',
	);
	expect(saveState(target)).toBe('saved');

	// It fails again, and this time the person discards it.
	chmodSync(join(root, 'transcriptions'), 0o555);
	try {
		type(field, 'Typed and then discarded.\n');
		expect((await editor.waitForSaves()).error).not.toBeNull();
	} finally {
		chmodSync(join(root, 'transcriptions'), 0o755);
	}
	await writeFile(join(root, A), transcript('Changed by another program.\n'));
	flushSync();
	click(target, 'Discard mine and load the file');
	await Bun.sleep(50);
	flushSync();

	expect(editorAt(library, A)).toBe(editor);
	expect(bodyField(target, 'a.md')?.value).toBe(
		'Changed by another program.\n',
	);
	expect(saveState(target)).toBe('saved');
	type(bodyField(target, 'a.md'), 'Typed into the loaded file.\n');
	expectOk(await editor.waitForSaves());
	expect(await readFile(join(root, A), 'utf8')).toContain(
		'Typed into the loaded file.',
	);
});

test('another program’s change is shown only after Reload from file', async () => {
	const { library, target, root } = await open({ [A]: transcript('Alpha.\n') });
	await show(library, A);
	await writeFile(join(root, A), transcript('From another program.\n'));
	await library.refreshAll();
	flushSync();

	expect(bodyField(target, 'a.md')?.value).toBe('Alpha.\n');

	click(target, 'Reload from file');
	await Bun.sleep(50);
	flushSync();
	expect(bodyField(target, 'a.md')?.value).toBe('From another program.\n');
	expect(saveState(target)).toBe('saved');
});

test('a transformation’s title and source are one editor, and its source preference outlives the view', async () => {
	const { library, page, target, root } = await open(
		{
			[RECIPE]:
				'---\ntitle: Clean up\nmodel: null\nendpoint: null\nowner: me\n---\nTidy.\n',
		},
		'transformations',
	);
	await library.open(RECIPE);
	flushSync();
	const title = target.querySelector<HTMLInputElement>(
		'[data-testid="transformation-title"]',
	);
	expect(title?.value).toBe('Clean up');
	type(title, 'Tidy up');
	const editor = untyped(editingOf(library.selectedTransformation?.slot));

	expect(library.editSource(RECIPE)).toBeUndefined();
	flushSync();
	// The title is not a live control while the source is the view.
	expect(title?.isConnected).toBe(false);
	expect(
		target.querySelector('[data-testid="transformation-title-text"]')
			?.textContent,
	).toBe('Tidy up');
	expectOk(await editor.waitForSaves());
	expect(await readFile(join(root, RECIPE), 'utf8')).toBe(
		'---\n"title": "Tidy up"\n"model": null\n"endpoint": null\n"owner": "me"\n---\nTidy.\n',
	);

	page.shown = false;
	flushSync();
	page.shown = true;
	flushSync();
	expect(editor.source).toBe(true);
	expect(
		target.querySelector('[data-testid="transformation-title"]'),
	).toBeNull();

	// Back to the fields: a new title control; the old one stays inert.
	expect(library.useForm(RECIPE)).toBeUndefined();
	flushSync();
	const again = target.querySelector<HTMLInputElement>(
		'[data-testid="transformation-title"]',
	);
	expect(again).not.toBe(title);
	type(title, 'Typed into the title of an earlier view');
	expect(editor.row).toMatchObject({ fields: { title: 'Tidy up' } });
	type(again, 'Typed now');
	expect(editor.row).toMatchObject({ fields: { title: 'Typed now' } });
});

test('a pasted value no file can hold stays in the control it was typed in, says why, and is let go only by repair or a discard', async () => {
	const { library, page, target, root } = await open({
		[A]: transcript('Alpha.\n'),
	});
	await show(library, A);
	const editor = editorAt(library, A);
	const lone = 'Half a pair: \uD800.\n';

	type(bodyField(target, 'a.md'), lone);
	flushSync();

	expect(saveState(target)).toBe('refused');
	expect(bodyField(target, 'a.md')?.value).toBe(lone);
	expect(editor.row).toMatchObject({ body: 'Alpha.\n' });
	// A new view of the same file shows it too.
	page.shown = false;
	flushSync();
	page.shown = true;
	flushSync();
	expect(bodyField(target, 'a.md')?.value).toBe(lone);

	// The source would hide it, so the view stays on the fields.
	expect(library.editSource(A)).toContain('Fix or discard');
	click(target, 'Discard what was typed in body');
	flushSync();
	expect(bodyField(target, 'a.md')?.value).toBe('Alpha.\n');
	expect(saveState(target)).toBe('saved');
	expect(await readFile(join(root, A), 'utf8')).toBe(transcript('Alpha.\n'));
});

test('controls from an earlier mode stay inert after that mode returns: fields, source, fields', async () => {
	const { library, target } = await open({ [A]: transcript('Alpha.\n') });
	await show(library, A);
	const editor = editorAt(library, A);
	const fields = bodyField(target, 'a.md');
	const toSource = [...target.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === 'Edit the whole file',
	);

	click(target, 'Edit the whole file');
	flushSync();
	const source = bodyField(target, 'a.md');
	expect(source).not.toBe(fields);
	const toFields = [...target.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === 'Edit the text only',
	);
	click(target, 'Edit the text only');
	flushSync();
	expect(editor.view).toBe('fields');
	const fieldsAgain = bodyField(target, 'a.md');
	expect(fieldsAgain).not.toBe(fields);

	// The fields view is eligible again, but its old controls are not this view's.
	type(fields, 'Typed into the first fields view.\n');
	type(source, 'Typed into the source view that is gone.\n');
	toSource?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	toFields?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	expect(editor.row).toMatchObject({ body: 'Alpha.\n' });
	expect(editor.source).toBe(false);

	type(fieldsAgain, 'Typed into the fields shown now.\n');
	expect(editor.row).toMatchObject({
		body: 'Typed into the fields shown now.\n',
	});
});

test('a transcript being renamed is read-only, typing delivered meanwhile is not left on screen, and a refused rename makes it editable again', async () => {
	const { library, target, root, holdMove } = await open({
		[A]: transcript('Alpha.\n'),
		[B]: transcript('Beta.\n'),
	});
	await show(library, A);
	const field = bodyField(target, 'a.md');
	const editor = editorAt(library, A);
	expect(field?.readOnly).toBe(false);
	const move = holdMove();

	// b.md exists, so the folder refuses the move once it is released.
	const renaming = library.rename(A, 'b.md');
	await move.reached;
	flushSync();
	expect(field?.readOnly).toBe(true);
	type(field, 'Typed while it moved.\n');
	await tick();
	expect(field?.value).toBe('Alpha.\n');
	expect(editor.row).toMatchObject({ body: 'Alpha.\n' });

	move.release();
	expect(await renaming).toContain('already exists');
	flushSync();
	expect(bodyField(target, 'a.md')).toBe(field);
	expect(field?.readOnly).toBe(false);
	type(field, 'Typed after the refusal.\n');
	expect(editor.row).toMatchObject({ body: 'Typed after the refusal.\n' });
	expectOk(await editor.waitForSaves());
	expect(await readFile(join(root, A), 'utf8')).toContain(
		'---\nTyped after the refusal.\n',
	);
});

test('an ordinary text file being renamed is read-only, typing delivered meanwhile is not left on screen, and a refused rename makes it editable again', async () => {
	const { library, target, root, holdMove } = await open({
		'notes.md': 'Saved.\n',
		'taken.md': 'Someone else.\n',
	});
	await show(library, 'notes.md');
	const selection = library.selection;
	if (selection?.kind !== 'file' || selection.file.kind !== 'text')
		throw new Error('expected notes.md open as text');
	const { editor } = selection.file;
	const field = bodyField(target, 'notes.md');
	expect(field?.readOnly).toBe(false);
	const move = holdMove();

	const renaming = library.rename('notes.md', 'taken.md');
	await move.reached;
	flushSync();
	expect(field?.readOnly).toBe(true);
	type(field, 'Typed while it moved.\n');
	await tick();
	expect(field?.value).toBe('Saved.\n');
	expect(editor.buffer).toBe('Saved.\n');

	move.release();
	expect(await renaming).toContain('already exists');
	flushSync();
	expect(field?.readOnly).toBe(false);
	type(field, 'Typed after the refusal.\n');
	expect(editor.buffer).toBe('Typed after the refusal.\n');
	expect(await editor.settle()).toBe(true);
	expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(
		'Typed after the refusal.\n',
	);
	expect(await readFile(join(root, 'taken.md'), 'utf8')).toBe('Someone else.\n');
});

const RECORDING = 'recordings/take.md';
const recording = (title: string, body: string) =>
	`---\ntitle: ${title}\nrecordedAt: 2026-10-01T00:00:00.000Z\ndurationMs: 1000\ncapture: fixture\naudioPath: recordings/take.wav\n---\n${body}`;

test('a recording’s title and notes stay live, with the typing on screen, after its save fails', async () => {
	const { library, target, root } = await open({
		[RECORDING]: recording('Take', 'Notes.\n'),
	});
	await show(library, RECORDING);
	const slot = library.selection;
	if (slot?.kind !== 'recording') throw new Error('expected the recording');
	const editor = untyped(editingOf(slot.slot));
	const title = target.querySelector<HTMLInputElement>(
		'input[aria-label="Recording title"]',
	);
	const notes = target.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label="Notes"]',
	);
	expect(title?.value).toBe('Take');

	chmodSync(join(root, 'recordings'), 0o555);
	try {
		type(notes, 'Typed notes.\n');
		expect((await editor.waitForSaves()).error).not.toBeNull();
	} finally {
		chmodSync(join(root, 'recordings'), 0o755);
	}
	flushSync();

	expect(saveState(target)).toBe('failed');
	expect(target.querySelector('input[aria-label="Recording title"]')).toBe(
		title,
	);
	expect(target.querySelector('textarea[aria-label="Notes"]')).toBe(notes);
	expect(notes?.value).toBe('Typed notes.\n');
	type(title, 'Retitled');
	expect(editor.row).toMatchObject({
		body: 'Typed notes.\n',
		fields: { title: 'Retitled' },
	});
	expectOk(await editor.waitForSaves());
	expect(await readFile(join(root, RECORDING), 'utf8')).toContain('Retitled');
	expect(await readFile(join(root, RECORDING), 'utf8')).toContain('Typed notes.');
});

test('a recording’s Source edits the same editor, and a source control from an earlier mode stays inert', async () => {
	const { library, target, root } = await open({
		[RECORDING]: recording('Take', 'Notes.\n'),
	});
	await show(library, RECORDING);
	const slot = library.selection;
	if (slot?.kind !== 'recording') throw new Error('expected the recording');
	const editor = untyped(editingOf(slot.slot));

	expect(library.editSource(RECORDING)).toBeUndefined();
	flushSync();
	expect(
		target.querySelector('input[aria-label="Recording title"]'),
	).toBeNull();
	expect(
		target.querySelector('[data-testid="notes-in-source"]'),
	).not.toBeNull();
	click(target, 'Source');
	flushSync();
	const source = target.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label="Markdown source"]',
	);
	expect(source?.value).toBe(recording('Take', 'Notes.\n'));

	expect(library.useForm(RECORDING)).toBeUndefined();
	flushSync();
	expect(library.editSource(RECORDING)).toBeUndefined();
	flushSync();
	const sourceAgain = target.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label="Markdown source"]',
	);
	expect(sourceAgain).not.toBe(source);

	type(source, recording('From an earlier source view', 'Notes.\n'));
	expect(editor.row.text).toBe(recording('Take', 'Notes.\n'));
	type(sourceAgain, recording('Typed as text', 'Notes.\n'));
	expectOk(await editor.waitForSaves());
	expect(await readFile(join(root, RECORDING), 'utf8')).toBe(
		recording('Typed as text', 'Notes.\n'),
	);
});
