/**
 * Mounted Timeline Tests
 *
 * The real `Timeline` component and its New capture dialog, compiled for the
 * client and mounted in jsdom over the real collection on a directory in a
 * temporary directory.
 *
 * Key behaviors:
 * - The New capture text lives in the collection, which outlives the view:
 *   its text box writes to it while it is shown, and nothing once the
 *   timeline is gone, though the collection is still there
 *
 * jsdom has no layout, focus, selection, or IME; these tests say what a
 * delivered event does, not that a person can type there.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDefinition } from '@epicenter/capture';
import { openFolder } from '@epicenter/folder/bun';
import { flushSync, mount, tick, unmount } from 'svelte';
import { expectOk } from 'wellcrafted/testing';
import { button, click, field, type } from '../svelte-dom.test-support.js';

const { createCaptures } = await import('../captures.svelte.ts');
const { default: Timeline } = await import('./Timeline.svelte');

const roots: string[] = [];
afterAll(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'capture-timeline-'));
	roots.push(root);
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
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	const view = mount(Timeline, {
		target,
		props: {
			captures,
			onOpen() {},
			onRepair() {},
			onCreated() {},
			onRecover() {},
		},
	});
	flushSync();
	return {
		captures,
		view,
		async done() {
			await captures.close();
			await folder.close();
		},
	};
}

/** Open the New capture dialog and return its text box. */
async function openNewCapture() {
	click(button('New capture'));
	flushSync();
	await tick();
	const box = field('new-capture');
	if (box === null) throw new Error('the New capture dialog did not open');
	return box;
}

test('the New capture text box writes nothing once the timeline is gone, though the collection is still there', async () => {
	const t = await setup();
	const box = await openNewCapture();
	type(box, 'typed in the dialog');
	expect(t.captures.newCapture).toBe('typed in the dialog');

	unmount(t.view);
	flushSync();
	type(box, 'delivered after the timeline went');
	expect(t.captures.newCapture).toBe('typed in the dialog');
	expect(t.captures.fenced).toBe(false);
	await t.done();
});
