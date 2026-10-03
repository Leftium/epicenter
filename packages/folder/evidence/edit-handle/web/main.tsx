/**
 * The demo page. One engine, `createFolderEdits`, over the HTTP facade:
 *
 * - `shared`: one handle passed to the vanilla, Solid, and Svelte callers,
 *   so all three show and edit one draft.
 * - `second`: an independent handle on the same row, so competing drafts
 *   can be compared with a shared one.
 * - `autosave`: this page's optional save policy for `shared`, off by default.
 * - immediate checkboxes save once per click with no handle; `notes.txt`
 *   opens its own handle.
 */
import { render } from 'solid-js/web';
import { mount, unmount } from 'svelte';
import { createFolderEdits } from '../folder-edits.js';
import { CALLER_SOURCES } from '../protocol.js';
import { FORM_STEM } from '../todos.js';
import { createAutosave } from './autosave.js';
import { h } from './dom.js';
import { connectDemoFolder } from './folder-http.js';
import { mountHandleStatus } from './handle-status.js';
import { mountHarness } from './harness.js';
import { mountImmediateList } from './immediate.js';
import { mountNotes } from './notes.js';
import { SolidPanel } from './SolidPanel.js';
import SveltePanel from './SveltePanel.svelte';
import { mountVanillaPanel } from './vanilla.js';

function slot(id: string): HTMLElement {
	const element = document.getElementById(id);
	if (element === null) throw new Error(`#${id} is missing from index.html`);
	return element;
}

const connection = connectDemoFolder();
const { generation, root } = await connection.session();
slot('root').textContent = root;
connection.onEvent((event) => {
	// A reset made a new folder: every handle on this page belongs to the old one.
	if (event.type === 'session' && event.generation !== generation)
		location.reload();
});

const { folder } = connection;
const edits = createFolderEdits(folder);
const displayed = await folder.tables.todos.get(FORM_STEM);
if (displayed.error || displayed.data === undefined)
	throw new Error(`todos/${FORM_STEM}.md could not be read`);

const shared = edits.tables.todos.edit(displayed.data);
const second = edits.tables.todos.edit(displayed.data);

function mountCallers() {
	const stopVanilla = mountVanillaPanel(slot('vanilla'), shared);
	const stopSolid = render(() => <SolidPanel edit={shared} />, slot('solid'));
	const svelte = mount(SveltePanel, {
		target: slot('svelte'),
		props: { edit: shared },
	});
	return () => {
		stopVanilla();
		stopSolid();
		void unmount(svelte);
	};
}

let unmountCallers: (() => void) | undefined = mountCallers();
const remount = slot('remount');
remount.onclick = () => {
	if (unmountCallers === undefined) {
		unmountCallers = mountCallers();
		remount.textContent = 'Unmount the three views';
	} else {
		unmountCallers();
		unmountCallers = undefined;
		remount.textContent = 'Mount the three views again';
	}
};

// Autosave is this page's policy for the shared draft: one timer and one
// subscription beside the handle, not inside any view, so it outlives
// remounts. Turning it off stops the driver; it never disposes the handle.
const autosaveToggle = h('input', {
	type: 'checkbox',
});
const autosavePause = h('p', { className: 'warn' });
const resumeAutosave = h(
	'button',
	{ type: 'button', hidden: true },
	'Resume autosave',
);
const PAUSED = {
	conflict: 'the file changed since its baseline',
	failed: 'a save failed',
	unconfirmed: 'a save reply was lost, so its outcome is unknown',
} as const;
const autosave = createAutosave(shared, {
	delayMs: 400,
	onPauseChange(paused) {
		autosavePause.textContent =
			paused === undefined
				? ''
				: `Autosave paused after ${PAUSED[paused]}. Review below, then resume. A changed file still blocks it until you keep your draft or take that version.`;
		resumeAutosave.hidden = paused === undefined;
	},
});
autosaveToggle.onchange = () =>
	autosaveToggle.checked ? autosave.start() : autosave.stop();
resumeAutosave.onclick = () => autosave.resume();
slot('autosave').replaceChildren(
	h('label', {}, autosaveToggle, ' Autosave shared draft (400 ms)'),
	autosavePause,
	resumeAutosave,
);

mount(SveltePanel, { target: slot('second'), props: { edit: second } });
mountHandleStatus(slot('shared-status'), shared);
mountHandleStatus(slot('second-status'), second);
mountImmediateList(slot('immediate'), { folder, edits });
await mountNotes(slot('notes'), { folder, edits });
mountHarness(
	{ controls: slot('controls'), disk: slot('disk'), log: slot('log') },
	connection,
);

const snippets = slot('snippets');
for (const name of CALLER_SOURCES) {
	const text = h('pre', {}, 'Loading…');
	snippets.append(h('details', {}, h('summary', {}, name), text));
	void connection.source(name).then((source) => {
		text.textContent = source;
	});
}
