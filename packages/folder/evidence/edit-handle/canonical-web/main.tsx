/**
 * The demo page and the editor's owner. It opens one canonical editor and
 * passes it to the vanilla, Solid, and Svelte views, which subscribe and
 * unsubscribe on their own. The owner alone disposes it: on Close, on Reset,
 * and before opening another row. Unmounting the views does not.
 *
 * The folder is the in-memory harness in `memory-folder.ts`, not a
 * persistent backend.
 */
import { render } from 'solid-js/web';
import { mount, unmount } from 'svelte';
import { createCanonicalEditors } from '../canonical-editor.js';
import { h } from './dom.js';
import { mountHarness } from './harness.js';
import { createMemoryFolder } from './memory-folder.js';
import { mountRepair } from './repair.js';
import { SolidPanel } from './SolidPanel.js';
import SveltePanel from './SveltePanel.svelte';
import { mountEditorStatus } from './status.js';
import type { TodoEditor } from './todo-editor.js';
import { definition, SEED, STEMS, type Stem, todoPath } from './todos.js';
import { mountVanillaPanel } from './vanilla.js';

function slot(id: string): HTMLElement {
	const element = document.getElementById(id);
	if (element === null) throw new Error(`#${id} is missing from index.html`);
	return element;
}

const events = slot('log');
function log(text: string) {
	events.prepend(
		h('li', {}, h('time', {}, new Date().toLocaleTimeString()), ` ${text}`),
	);
}

const harness = createMemoryFolder({ seed: SEED, log });
const { edit: openTodo } = createCanonicalEditors(harness.folder, definition)
	.tables.todos;

let stem: Stem = 'plan';
/** The opening in progress; aborted by Close, Reset, or another Open. */
let opening: AbortController | undefined;
let editor: TodoEditor | undefined;
let unmountStatus: (() => void) | undefined;
let unmountViews: (() => void) | undefined;

const session = slot('session');
const cancel = h('button', { type: 'button', hidden: true }, 'Cancel opening');
cancel.onclick = () => {
	opening?.abort();
	opening = undefined;
	cancel.hidden = true;
};
const toggleViews = h(
	'button',
	{ type: 'button', disabled: true },
	'Mount the three views',
);
toggleViews.onclick = () => {
	if (unmountViews !== undefined) {
		unmountViews();
		unmountViews = undefined;
	} else if (editor !== undefined) mountViews(editor);
	toggleViews.textContent =
		unmountViews === undefined
			? 'Mount the three views again'
			: 'Unmount the three views';
};
const stemSelect = h(
	'select',
	{},
	...Object.entries(STEMS).map(([value, label]) =>
		h('option', { value }, `${todoPath(value)}: ${label}`),
	),
);
stemSelect.onchange = () => {
	stem = stemSelect.value as Stem;
	harnessView.show();
	void open();
};
slot('owner').replaceChildren(
	h('label', {}, 'Row ', stemSelect),
	h('button', { type: 'button', onclick: () => void open() }, 'Open'),
	cancel,
	h('button', { type: 'button', onclick: () => void close() }, 'Close'),
	h('button', { type: 'button', onclick: () => void reset() }, 'Reset harness'),
	toggleViews,
);

const harnessView = mountHarness(slot('harness'), {
	harness,
	target: () => todoPath(stem),
});

async function open() {
	opening?.abort();
	const controller = new AbortController();
	opening = controller;
	await closeEditor();
	if (controller.signal.aborted) return;
	const path = todoPath(stem);
	session.textContent = `Opening ${path}…`;
	cancel.hidden = false;
	log(`Opening ${path}`);
	const { data: opened, error } = await openTodo(stem, {
		signal: controller.signal,
	});
	if (controller.signal.aborted) {
		// Cancelled or superseded. An editor that opened anyway is ours to end.
		if (error === null) void opened.dispose();
		log(`Opening ${path} was cancelled`);
		if (opening === undefined) session.textContent = 'Opening cancelled.';
		return;
	}
	opening = undefined;
	cancel.hidden = true;
	if (error !== null) {
		log(`Opening ${path} refused: ${error.name}`);
		session.textContent = `${path} did not open.`;
		mountRepair(slot('repair'), {
			error,
			path,
			files: harness.folder.files,
			reopen: () => void open(),
		});
		return;
	}
	editor = opened;
	log(`Opened ${path}`);
	session.textContent = `Editing ${path}. Every view below shares this one editor.`;
	unmountStatus = mountEditorStatus(slot('status'), opened);
	mountViews(opened);
}

function mountViews(current: TodoEditor) {
	const stopVanilla = mountVanillaPanel(slot('vanilla'), current);
	const stopSolid = render(
		() => <SolidPanel editor={current} />,
		slot('solid'),
	);
	const svelte = mount(SveltePanel, {
		target: slot('svelte'),
		props: { editor: current },
	});
	unmountViews = () => {
		stopVanilla();
		stopSolid();
		void unmount(svelte);
	};
	toggleViews.disabled = false;
	toggleViews.textContent = 'Unmount the three views';
}

/** Unmount everything that shows the editor, then dispose it. */
async function closeEditor() {
	const closing = editor;
	editor = undefined;
	unmountViews?.();
	unmountViews = undefined;
	toggleViews.disabled = true;
	toggleViews.textContent = 'Mount the three views';
	unmountStatus?.();
	unmountStatus = undefined;
	slot('repair').replaceChildren();
	if (closing === undefined) return;
	const { get, dispose } = closing;
	if (get().saving !== undefined)
		session.textContent =
			'Closing: waiting for the admitted save to settle. Release a held reply to finish.';
	await dispose();
	log(`Disposed the editor for ${get().path}`);
}

async function close() {
	opening?.abort();
	opening = undefined;
	cancel.hidden = true;
	await closeEditor();
	session.textContent = 'Closed.';
}

async function reset() {
	// A held reply would keep disposal waiting; deliver it first.
	harness.release();
	await close();
	harness.reset();
	harnessView.show();
	await open();
}

await open();
