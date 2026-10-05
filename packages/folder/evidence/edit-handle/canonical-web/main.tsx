/**
 * The demo page and the editor's owner. It opens the demo folder with the
 * production browser opener, which picks this browser's default storage, and
 * acquires one row editor with `folder.tables.todos.edit`. The vanilla,
 * Solid, and Svelte views and the status panel share that editor; each
 * subscribes on its own, and unmounting one ends only its observation. The
 * page keeps the editor itself, so an admitted save settles whether or not
 * any view is mounted. There is nothing to dispose.
 *
 * Close, Open, another row, and Reset are transitions, one at a time from
 * start to finish. Each leaves the current editor first: it stops input by
 * unmounting every view, then waits for the admitted saves to settle. A
 * failed save keeps the editor: the person goes back to it, or discards its
 * input on purpose. Discarding drops the editor; opening the row again reads
 * the file. Only the last step of a transition installs an editor.
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
	type RowSaveError,
} from '../../../src/browser.js';
import { h } from './dom.js';
import { mountRawFiles } from './raw-files.js';
import { SolidPanel } from './SolidPanel.js';
import SveltePanel from './SveltePanel.svelte';
import { mountEditorStatus } from './status.js';
import {
	describeOpenError,
	describeSaveError,
	type Presentation,
	type TodoEditor,
} from './todo-editor.js';
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
		case 'opfs':
			return `OPFS directory "${location.directory}" of ${window.location.origin}`;
		case 'directory':
			return `the directory ${location.root}`;
		default:
			// A backend this page does not know yet still says where it is.
			return JSON.stringify(location);
	}
}

const { data: opened, error: openError } = await openBrowserFolder({
	id: DEMO_FOLDER_ID,
	definition,
});
if (openError !== null) {
	session.textContent = `The demo folder did not open: ${openError.message}`;
	throw new Error(openError.message);
}
// Hoisted functions below read this binding, so it carries the narrowed type.
const folder = opened;
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
	const { data: rows, error: listError } = await folder.tables.todos.list();
	if (listError !== null) {
		log(`Could not list todos: ${listError.message}`);
		return;
	}
	if (rows.length > 0) {
		log(`The folder has ${rows.length} todo rows; nothing seeded`);
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

/**
 * The editor this page keeps, the row it edits, and each view's own choice
 * of fields or source. The choices outlive the views, so a view mounted
 * again starts where it left off; no view reads another's.
 */
type Owner = {
	readonly stem: Stem;
	readonly editor: TodoEditor;
	readonly views: {
		readonly vanilla: Presentation;
		readonly solid: Presentation;
		readonly svelte: Presentation;
	};
};

/**
 * One owner transition: leaving the current row, then what the person asked
 * for, such as opening a row or resetting. Only one runs at a time, from the
 * first step to the last, so nothing installs an owner past another one's
 * drain. `acquiring` is set while it waits for `table.edit`; only Close
 * aborts it.
 */
type Transition = { readonly action: string; acquiring?: AbortController };

let owner: Owner | undefined;
let transition: Transition | undefined;
let unmountViews: (() => void) | undefined;
/**
 * The row the selector shows and the raw file panel targets: the owner's,
 * or, once a transition has released it, the row that transition opens.
 */
let selectedStem: Stem = 'plan';

const toggleViews = h(
	'button',
	{ type: 'button', disabled: true },
	'Mount the views again',
);
toggleViews.onclick = () => {
	// During a transition the views stay unmounted: that is what stops input.
	if (owner === undefined || transition !== undefined) return;
	if (unmountViews !== undefined) {
		hideViews();
		session.textContent = `Views unmounted. Nothing observes ${todoPath(owner.stem)}; the page keeps its editor, and an admitted save still settles.`;
	} else showViews(owner);
};
const stemSelect = h(
	'select',
	{},
	...Object.entries(STEMS).map(([value, label]) =>
		h('option', { value }, `${todoPath(value)}: ${label}`),
	),
);
stemSelect.onchange = () => openRow(stemSelect.value as Stem);
slot('owner').replaceChildren(
	h('label', {}, 'Row ', stemSelect),
	h(
		'button',
		{ type: 'button', onclick: () => openRow(stemSelect.value as Stem) },
		'Open',
	),
	h('button', { type: 'button', onclick: close }, 'Close'),
	toggleViews,
);

/** Open `stem`, the row chosen when the person asked, after leaving the current one. */
function openRow(stem: Stem) {
	void run(`Open ${todoPath(stem)}`, (step) => open(stem, step), stem);
}

function select(stem: Stem) {
	selectedStem = stem;
	stemSelect.value = stem;
	void rawFiles.show();
}
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
	target: () => todoPath(selectedStem),
	log,
});

function showViews(current: Owner) {
	hideViews();
	const { editor, views } = current;
	const stopVanilla = mountVanillaPanel(slot('vanilla'), editor, views.vanilla);
	const stopSolid = render(
		() => <SolidPanel editor={editor} presentation={views.solid} />,
		slot('solid'),
	);
	// Svelte removes the view at once, but not its bindings' listeners: the
	// panel's setters check that it is still mounted.
	const svelte = mount(SveltePanel, {
		target: slot('svelte'),
		props: { rowEditor: editor, presentation: views.svelte },
	});
	const stopStatus = mountEditorStatus(slot('status'), editor, log);
	unmountViews = () => {
		stopVanilla();
		stopSolid();
		void unmount(svelte);
		stopStatus();
	};
	toggleViews.disabled = false;
	toggleViews.textContent = 'Unmount the views';
	session.textContent = `Editing ${todoPath(current.stem)}. Every view below shares this one editor.`;
}

/** Unmount every view: no control can submit input after this returns. */
function hideViews() {
	unmountViews?.();
	unmountViews = undefined;
	toggleViews.disabled = owner === undefined;
	toggleViews.textContent = 'Mount the views again';
}

/**
 * Run one transition: release the current editor, then `next`. Input stops
 * first, then the admitted saves settle. When the last one failed, the
 * person decides: back to the editor, with nothing released and `next` not
 * run, or discard its input. The transition holds the page until `next`
 * finishes, and a request during it is refused without disturbing it. The
 * selector and the raw file panel move to `destination` only once the
 * release succeeded, so while the choice is pending they still name the row
 * whose input failed.
 */
async function run(
	action: string,
	next: (step: Transition) => void | Promise<void>,
	destination?: Stem,
) {
	if (transition !== undefined) {
		log(`${action}: refused while "${transition.action}" runs`);
		select(selectedStem);
		return;
	}
	const step: Transition = { action };
	transition = step;
	try {
		if (await release(action)) {
			if (destination !== undefined) select(destination);
			await next(step);
		} else if (owner !== undefined) select(owner.stem); // still editing the kept row
	} finally {
		transition = undefined;
	}
}

/**
 * Close. While a transition waits for `table.edit`, Close cancels that
 * acquisition instead, which leaves no editor: the one request whose intent
 * a cancellation fulfils. Any other request is refused and leaves the
 * running one alone.
 */
function close() {
	if (transition?.acquiring !== undefined) {
		transition.acquiring.abort();
		log(`Close: cancelled the acquisition for "${transition.action}"`);
		return;
	}
	void run('Close', () => {
		session.textContent = 'Closed. No editor is kept.';
	});
}

async function release(action: string): Promise<boolean> {
	slot('diagnostic').replaceChildren();
	const current = owner;
	if (current === undefined) return true;
	hideViews();
	const path = todoPath(current.stem);
	if (current.editor.get().save.status === 'saving')
		session.textContent = `${action}: input to ${path} has stopped; waiting for its admitted saves to settle.`;
	const { error } = await current.editor.flush();
	if (error !== null && !(await discardAfter(action, path, error))) {
		showViews(current);
		return false;
	}
	owner = undefined;
	hideViews();
	log(`Released the editor for ${path}`);
	return true;
}

/** Ask whether to discard input whose save failed. Resolves `true` to discard. */
function discardAfter(
	action: string,
	path: string,
	error: RowSaveError,
): Promise<boolean> {
	const choice = slot('lifetime');
	session.textContent = `${action} is waiting: the last save to ${path} failed.`;
	return new Promise((resolve) => {
		const decide = (discard: boolean) => {
			choice.replaceChildren();
			if (discard) log(`Discarded the input for ${path} that did not save`);
			resolve(discard);
		};
		choice.replaceChildren(
			h(
				'p',
				{ className: 'warn' },
				`${describeSaveError(error)} ${action} would drop the editor and the input it kept.`,
			),
			h(
				'div',
				{ className: 'row' },
				h(
					'button',
					{ type: 'button', onclick: () => decide(false) },
					'Keep editing',
				),
				h(
					'button',
					{ type: 'button', onclick: () => decide(true) },
					`Discard that input and ${action.toLowerCase()}`,
				),
			),
		);
	});
}

/**
 * Acquire an editor for `stem` and keep it: the only place an owner is
 * installed. It runs as the last step of a transition whose release left no
 * owner. A refusal leaves no editor and writes nothing.
 */
async function open(stem: Stem, step: Transition) {
	if (transition !== step || owner !== undefined)
		throw new Error('An owner is installed only by its own transition');
	const controller = new AbortController();
	step.acquiring = controller;
	const path = todoPath(stem);
	session.textContent = `Opening ${path}…`;
	log(`Opening ${path}`);
	const { data: editor, error } = await folder.tables.todos.edit(stem, {
		signal: controller.signal,
	});
	step.acquiring = undefined;
	if (error !== null) {
		log(`Opening ${path} returned ${error.name}`);
		session.textContent = `${path} has no editor. Opening wrote nothing.`;
		slot('diagnostic').replaceChildren(
			h('p', { className: 'warn' }, `${error.name}: ${describeOpenError(error)}`),
			h('button', { type: 'button', onclick: () => openRow(stem) }, 'Try opening again'),
		);
		return;
	}
	owner = {
		stem,
		editor,
		views: {
			vanilla: { raw: false },
			solid: { raw: false },
			svelte: { raw: false },
		},
	};
	log(`Opened ${path}: the row is ${editor.get().row.status}`);
	showViews(owner);
}

/**
 * The disposable demo's reset, after asking: overwrite each seed row with its
 * seed text, then remove `gone.md`, one file at a time. Each write is an
 * ordinary save that other tabs hear. The first failure stops the reset; the
 * writes before it stay, and the log names each one and the failing path.
 */
async function reset() {
	// The row to open afterward is the one selected when the person asked.
	const stem = selectedStem;
	const asked = window.confirm(
		`Reset the demo rows in "${DEMO_FOLDER_ID}"?\n\n` +
			`This overwrites ${Object.keys(SEED).join(', ')} with their seed text and removes ${todoPath('gone')}, one file at a time. ` +
			'The open editor is released first, and the replaced text is not kept anywhere this page guarantees. ' +
			'"Show recent commits" lists the versions history recorded.',
	);
	if (!asked) return;
	await run('Reset', async (step) => {
		await resetFiles();
		void rawFiles.show();
		await open(stem, step);
	});
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
	const { data: gone, error: readError } = await folder.files.read(path);
	if (readError !== null) {
		if (readError.name === 'NotFound') log(`Reset: ${path} is already absent`);
		else log(`Reset stopped at ${path}: ${readError.message}`);
		return;
	}
	// Conditional on the bytes just read: a newer write there is not removed.
	const { error } = await folder.files.remove(gone);
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

openRow(selectedStem);
