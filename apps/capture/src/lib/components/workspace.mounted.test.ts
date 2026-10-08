/**
 * Mounted Workspace Tests
 *
 * The real `Workspace` component, compiled for the client and mounted in
 * jsdom over the real collection on a directory in a temporary directory.
 * Navigation is a prop the test changes, as the page's address would.
 *
 * Key behaviors:
 * - The timeline and Files open the one draft the page holds for a file:
 *   moving between them mounts the other view over that draft, the old
 *   view's controls reach nothing, and a failed save's text and choices are
 *   the same in both, never the file's bytes read again
 * - A draft let go and opened again at the same path mounts a new view
 * - Moving between workspaces while the editor opens acquires it once
 * - The timeline lists only files that read as captures, names the rest with
 *   their path and reason, and opens them in Files, which stays Files after
 *   the repair
 *
 * jsdom has no layout, focus, selection, or IME; these tests say what a
 * delivered event does, not that a person can type there.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDefinition, toTextarea } from '@epicenter/capture';
import { openFolder } from '@epicenter/folder/bun';
import { flushSync, mount, unmount } from 'svelte';
import { expectOk } from 'wellcrafted/testing';
import { click, field, type } from '../svelte-dom.test-support.js';
import type { Place } from './Workspace.svelte';

const { createCaptures } = await import('../captures.svelte.ts');
const { switchable } = await import('../switchable.test-support.svelte.ts');
const { default: Workspace } = await import('./Workspace.svelte');

const roots: string[] = [];
afterAll(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

const AT = '2026-10-04T20:49:23.041Z';
const fileOf = (text: string) =>
	[`---`, `capturedAt: ${AT}`, `---`, ``, text, ``, `## Thoughts`, ``].join(
		'\n',
	);
const canonical = (text: string) =>
	`---\n"capturedAt": "${AT}"\n---\n\n${text}\n\n## Thoughts\n`;

async function setup(
	sources: Record<string, string>,
	initial: Place = { kind: 'timeline' },
) {
	const root = await mkdtemp(join(tmpdir(), 'capture-workspace-'));
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
	/** Every acquisition, by stem. */
	const edits: string[] = [];
	/** Held before the next acquisition reads anything. */
	const next: { edit?: Promise<void> } = {};
	const captures = createCaptures({
		folder: {
			files: folder.files,
			git: folder.git,
			tables: {
				captures: {
					...folder.tables.captures,
					async edit(stem, options) {
						edits.push(stem);
						const held = next.edit;
						next.edit = undefined;
						await held;
						return folder.tables.captures.edit(stem, options);
					},
				},
			},
		},
		location: folder.location,
	});
	await captures.refresh();
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	const place = switchable<Place>(initial);
	/** Every navigation the view asked for. */
	const went: Place[] = [];
	const view = mount(Workspace, {
		target,
		props: {
			captures,
			get place() {
				return place.value;
			},
			created: undefined,
			go(to) {
				went.push(to);
				place.value = to;
			},
		},
	});
	flushSync();
	return {
		captures,
		target,
		place,
		went,
		edits,
		/** Hold the next acquisition until the returned function is called. */
		holdNextEdit() {
			const held = Promise.withResolvers<void>();
			next.edit = held.promise;
			return held.resolve;
		},
		/** Show `to`, and wait until its draft's editor has opened. */
		async show(to: Place) {
			place.value = to;
			flushSync();
			if (to.kind === 'capture' || to.kind === 'file')
				await captures.draft(to.stem)?.ready;
			flushSync();
		},
		disk: (stem: string) =>
			readFile(join(root, 'captures', `${stem}.md`), 'utf8'),
		write: (stem: string, source: string) =>
			writeFile(join(root, 'captures', `${stem}.md`), source),
		alert: (label: string) =>
			target.querySelector(`[aria-label="${label}"]`),
		async done() {
			unmount(view);
			await captures.close();
			await folder.close();
		},
	};
}

test('moving between workspaces mounts the other view over the one draft; old controls reach nothing, and a failed save stays with its text in both', async () => {
	const t = await setup({ one: fileOf('Before') });
	await t.show({ kind: 'capture', stem: 'one' });
	const draft = t.captures.draft('one');
	if (!draft) throw new Error('no draft');
	const captureBox = field('capture-text');
	type(captureBox, 'typed in the timeline');
	await draft.settle();
	expect(await t.disk('one')).toBe(canonical('typed in the timeline'));

	await t.show({ kind: 'file', stem: 'one' });
	expect(field('capture-text')).toBeNull();
	const fileBox = field('file-text');
	expect(fileBox?.value).toBe(canonical('typed in the timeline'));
	type(captureBox, 'from the destroyed capture view');
	expect(draft.text).toBe('typed in the timeline');

	// A save that fails from Files keeps its text and its choices there.
	const failed = canonical('lone \uD800');
	type(fileBox, failed);
	await draft.settle();
	flushSync();
	expect(t.alert('Save failed')).not.toBeNull();
	expect(await t.disk('one')).toBe(canonical('typed in the timeline'));
	// Another program changes the file meanwhile.
	await t.write('one', fileOf('From another program'));

	// The timeline's view of the same capture shows the same failure and no fields.
	await t.show({ kind: 'capture', stem: 'one' });
	expect(t.captures.draft('one')).toBe(draft);
	expect(t.alert('Save failed')).not.toBeNull();
	expect(t.alert('Needs repair')).not.toBeNull();
	expect(t.target.querySelector('textarea')).toBeNull();

	// Back in Files: a new text box with the failed text, not the file read again.
	await t.show({ kind: 'file', stem: 'one' });
	const again = field('file-text');
	expect(again).not.toBe(fileBox);
	expect(again?.value).toBe(toTextarea(failed));
	type(fileBox, 'from the destroyed file view');
	expect(draft.source).toBe(failed);
	expect(t.edits).toEqual(['one']);

	type(again, canonical('fixed'));
	await draft.settle();
	flushSync();
	expect(t.alert('Save failed')).toBeNull();
	expect(await t.disk('one')).toBe(canonical('fixed'));
	await t.done();
});

test('a draft let go and opened again at the same path mounts a new view, and the old one reaches nothing', async () => {
	const t = await setup({ one: fileOf('Before') });
	await t.show({ kind: 'capture', stem: 'one' });
	const first = t.captures.draft('one');
	if (!first) throw new Error('no draft');
	const oldBox = field('capture-text');

	await t.captures.discard(first);
	expect(first.retired).toBe(true);
	// Still addressed, so the view opens the file again with a new editor.
	flushSync();
	const second = t.captures.draft('one');
	expect(second).toBeDefined();
	expect(second).not.toBe(first);
	await second?.ready;
	flushSync();
	const box = field('capture-text');
	expect(box).not.toBe(oldBox);
	expect(t.edits).toEqual(['one', 'one']);

	type(oldBox, 'from the old view');
	expect(second?.text).toBe('Before');
	type(box, 'from the new view');
	await second?.settle();
	expect(await t.disk('one')).toBe(canonical('from the new view'));
	await t.done();
});

test('moving between workspaces while the editor opens acquires it once, and the view shown is the last one chosen', async () => {
	const t = await setup({ one: fileOf('Before') });
	const release = t.holdNextEdit();
	t.place.value = { kind: 'capture', stem: 'one' };
	flushSync();
	const draft = t.captures.draft('one');
	expect(draft?.opened).toBe(false);
	t.place.value = { kind: 'file', stem: 'one' };
	flushSync();
	t.place.value = { kind: 'capture', stem: 'one' };
	flushSync();
	t.place.value = { kind: 'file', stem: 'one' };
	flushSync();
	expect(t.target.querySelector('textarea')).toBeNull();
	release();
	await draft?.ready;
	flushSync();
	expect(t.captures.draft('one')).toBe(draft);
	expect(t.edits).toEqual(['one']);
	expect(field('capture-text')).toBeNull();
	expect(field('file-text')?.value).toBe(fileOf('Before'));
	await t.done();
});

test('the timeline lists only captures and names each file to repair; Files opens it and stays Files after the repair', async () => {
	const broken = fileOf('Broken').replace(`capturedAt: ${AT}`, 'capturedAt: [');
	const twice = fileOf('Twice\n\n## Thoughts\n\n- theirs');
	const t = await setup({ good: fileOf('Good'), broken, twice });
	const listed = t.alert('Timeline captures');
	expect(listed?.textContent).toContain('Good');
	expect(listed?.textContent).not.toContain('Broken');
	expect(listed?.textContent).not.toContain('Twice');

	const repairs = t.alert('Files to repair');
	expect(repairs?.textContent).toContain('captures/broken.md');
	expect(repairs?.textContent).toContain('captures/twice.md');
	expect(repairs?.textContent).toContain(
		'2 headings read "Thoughts". The thoughts list needs exactly one.',
	);
	const open = t.alert('Open captures/broken.md in Files');
	if (!open) throw new Error('no repair entry');
	click(open);
	expect(t.went).toEqual([{ kind: 'file', stem: 'broken' }]);
	flushSync();
	await t.captures.draft('broken')?.ready;
	flushSync();

	const box = field('file-text');
	expect(box?.value).toBe(broken);
	expect(field('capture-text')).toBeNull();
	type(box, fileOf('Repaired'));
	await t.captures.draft('broken')?.settle();
	await t.captures.refresh();
	flushSync();
	expect(await t.disk('broken')).toBe(fileOf('Repaired'));
	// Files is still showing it as text; only navigation opens it as a capture.
	expect(t.place.value).toEqual({ kind: 'file', stem: 'broken' });
	expect(field('file-text')).toBe(box);
	expect(field('capture-text')).toBeNull();
	expect(t.captures.editable.map((row) => row.stem).sort()).toEqual([
		'broken',
		'good',
	]);
	expect(t.captures.repairs.map((row) => row.path)).toEqual([
		'captures/twice.md',
	]);
	await t.done();
});
