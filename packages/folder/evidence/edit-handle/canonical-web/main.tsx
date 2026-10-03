/**
 * The demo page and the editor's owner. It opens the demo folder with the
 * production browser opener, which picks this browser's default storage, and
 * opens one row editor with `folder.tables.todos.edit`. The vanilla, Solid,
 * and Svelte views share that editor and subscribe and unsubscribe on their
 * own. The owner alone disposes it: on Close, on Reset, and before opening
 * another row. Unmounting the views does not.
 *
 * The folder persists across reloads and is shared by every tab of this
 * origin. Loading writes nothing except the seed rows of a folder that has no
 * todos yet; Reset is the only other write the page makes on its own. Both
 * write one file at a time through `folder.files`.
 */
import { render } from 'solid-js/web';
import { mount, unmount } from 'svelte';
import {
	type FolderLocation,
	openFolder as openBrowserFolder,
} from '../../../src/browser.js';
import { h } from './dom.js';
import { mountRawFiles } from './raw-files.js';
import { mountRepair } from './repair.js';
import { SolidPanel } from './SolidPanel.js';
import SveltePanel from './SveltePanel.svelte';
import { mountEditorStatus } from './status.js';
import type { TodoEditor } from './todo-editor.js';
import {
	DEMO_FOLDER_ID,
	definition,
	SEED,
	STEMS,
	type Stem,
	todoPath,
} from './todos.js';
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
const session = slot('session');

/** Where the opener put the folder, as it reports it. */
function describeLocation(location: FolderLocation): string {
	switch (location.kind) {
		case 'indexedDb':
			return `IndexedDB database "${location.database}" of ${window.location.origin}`;
		case 'directory':
			return `the directory ${location.root}`;
		default:
			// A backend this page does not know yet still says where it is.
			return JSON.stringify(location);
	}
}

const opened = await openBrowserFolder({ id: DEMO_FOLDER_ID, definition });
if (opened.error !== null) {
	session.textContent = `The demo folder did not open: ${opened.error.message}`;
	throw new Error(opened.error.message);
}
const folder = opened.data;
slot('location').textContent =
	`Folder "${DEMO_FOLDER_ID}" in ${describeLocation(folder.location)}. ` +
	`Automatic commits: ${folder.git.snapshot.commitOnEdit ? 'on' : 'off'}.`;
log(`Opened the folder: ${describeLocation(folder.location)}`);

/**
 * Seed a folder with no todo rows, one exclusive create per file. A path
 * already occupied, such as by a second tab seeding at the same moment, is
 * left as it is. Any other failure stops seeding; the files created before
 * it stay.
 */
async function seedEmptyFolder() {
	const listed = await folder.tables.todos.list();
	if (listed.error !== null) {
		log(`Could not list todos: ${listed.error.message}`);
		return;
	}
	if (listed.data.length > 0) {
		log(`The folder has ${listed.data.length} todo rows; nothing seeded`);
		return;
	}
	for (const [path, text] of Object.entries(SEED)) {
		const { error } = await folder.files.create(path, text);
		if (error === null) log(`Seeded ${path}`);
		else if (error.name === 'Exists')
			log(`Not seeded ${path}: it is occupied, left as it is`);
		else {
			log(`Seeding stopped at ${path}: ${error.message}`);
			return;
		}
	}
}
await seedEmptyFolder();

let stem: Stem = 'plan';
/** The opening in progress; aborted by Close, Reset, or another Open. */
let opening: AbortController | undefined;
let editor: TodoEditor | undefined;
let unmountStatus: (() => void) | undefined;
let unmountViews: (() => void) | undefined;

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
	void rawFiles.show();
	void open();
};
slot('owner').replaceChildren(
	h('label', {}, 'Row ', stemSelect),
	h('button', { type: 'button', onclick: () => void open() }, 'Open'),
	h('button', { type: 'button', onclick: () => void close() }, 'Close'),
	toggleViews,
);
slot('reset').replaceChildren(
	h(
		'button',
		{ type: 'button', onclick: () => void reset() },
		'Reset the demo rows…',
	),
	h(
		'button',
		{ type: 'button', onclick: () => void showHistory() },
		'Show recent commits',
	),
);

const rawFiles = mountRawFiles(slot('raw'), {
	folder,
	target: () => todoPath(stem),
	log,
});

async function open() {
	opening?.abort();
	const controller = new AbortController();
	opening = controller;
	await closeEditor();
	if (controller.signal.aborted) return;
	const path = todoPath(stem);
	session.textContent = `Opening ${path}…`;
	log(`Opening ${path}`);
	const { data: next, error } = await folder.tables.todos.edit(stem, {
		signal: controller.signal,
	});
	if (controller.signal.aborted) {
		// Superseded. An editor that opened anyway is ours to end.
		if (error === null) void next.dispose();
		log(`Opening ${path} was superseded`);
		return;
	}
	opening = undefined;
	if (error !== null) {
		log(`Opening ${path} refused: ${error.name}`);
		session.textContent = `${path} did not open. Opening wrote nothing.`;
		mountRepair(slot('repair'), {
			error,
			path,
			files: folder.files,
			reopen: () => void open(),
		});
		return;
	}
	editor = next;
	log(`Opened ${path}`);
	session.textContent = `Editing ${path}. Every view below shares this one editor.`;
	unmountStatus = mountEditorStatus(slot('status'), next);
	mountViews(next);
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
		session.textContent = 'Closing: waiting for the admitted save to settle.';
	await dispose();
	log(`Disposed the editor for ${get().path}`);
}

async function close() {
	opening?.abort();
	opening = undefined;
	await closeEditor();
	session.textContent = 'Closed.';
}

/**
 * The disposable demo's reset, after asking: overwrite each seed row with its
 * seed text, then remove `gone.md`, one file at a time. Each write is an
 * ordinary save that other tabs hear. The first failure stops the reset; the
 * writes before it stay, and the log names each one and the failing path.
 */
async function reset() {
	const asked = window.confirm(
		`Reset the demo rows in "${DEMO_FOLDER_ID}"?\n\n` +
			`This overwrites ${Object.keys(SEED).join(', ')} with their seed text and removes ${todoPath('gone')}, one file at a time. ` +
			'Unsaved drafts in this tab are discarded, and the replaced text is not kept anywhere this page guarantees. ' +
			'"Show recent commits" lists the versions history recorded.',
	);
	if (!asked) return;
	await close();
	await resetFiles();
	void rawFiles.show();
	await open();
}

/** Write the reset one file at a time; stop at the first failure and say where. */
async function resetFiles() {
	for (const [path, text] of Object.entries(SEED)) {
		const { error } = await folder.files.overwrite(path, text);
		if (error !== null) {
			log(`Reset stopped at ${path}: ${error.message}`);
			return;
		}
		log(`Reset ${path} to its seed text`);
	}
	const path = todoPath('gone');
	const gone = await folder.files.read(path);
	if (gone.error !== null) {
		if (gone.error.name === 'NotFound') log(`Reset: ${path} is already absent`);
		else log(`Reset stopped at ${path}: ${gone.error.message}`);
		return;
	}
	// Conditional on the bytes just read: a newer write there is not removed.
	const { error } = await folder.files.remove(gone.data);
	log(
		error === null
			? `Reset removed ${path}`
			: `Reset stopped at ${path}: ${error.message}`,
	);
}

async function showHistory() {
	const list = slot('history');
	const { data: commits, error } = await folder.git.log(8);
	if (error !== null) {
		list.replaceChildren(h('li', {}, `No history: ${error.message}`));
		return;
	}
	list.replaceChildren(
		...commits.map((commit) =>
			h(
				'li',
				{},
				`${commit.oid.slice(0, 8)} ${new Date(commit.author.timestamp * 1000).toLocaleTimeString()}: ${commit.message.split('\n')[0]}`,
			),
		),
	);
}

await open();
