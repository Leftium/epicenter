/**
 * Journeys through the row editor callers page as a browser gets it.
 *
 *     bun packages/folder/evidence/edit-handle/canonical-page.journeys.ts
 *
 * `canonical-build.ts`'s Vite configuration builds `canonical-web/` to a
 * temporary directory, and its entry module runs in jsdom, opening its
 * folder through the production browser opener over the in-memory OPFS
 * (`src/opfs.test-support.ts`). Each journey acts only through the page's
 * own DOM and reads the folder's files from that OPFS. It prints one PASS or
 * FAIL line per journey and exits nonzero on the first failure.
 *
 * `canonical-page.test.ts` runs this file in its own process: under
 * `bun test --isolate`, `import()` of a module with top-level await, as the
 * page's entry is, returns at its first await and the rest never runs.
 *
 * jsdom has no layout, focus, IME, or assistive technology; these journeys
 * show what a delivered event does, not how a person delivers one. The
 * memory OPFS models storage; it does not show what a browser does.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { type MemoryOpfs, memoryOpfs } from '../../src/opfs.test-support.js';
import { createWebLocks } from '../../src/web-locks.test-support.js';
import { canonicalViteConfig } from './canonical-dev.js';

const decoder = new TextDecoder();
type View = 'vanilla' | 'solid' | 'svelte';

/** While set, reading the named file waits for `until`: a slow acquisition. */
let heldRead: { readonly name: string; readonly until: Promise<void> } | undefined;

/**
 * The memory OPFS as the page gets it: the same handles, except that
 * `getFile` on the file `heldRead` names waits. The memory OPFS has no read
 * fault of its own; nothing in the store compares handles by identity.
 */
function holdable<T extends object>(handle: T): T {
	return new Proxy(handle, {
		get(target, key) {
			const value = Reflect.get(target, key);
			if (typeof value !== 'function') return value;
			if (key === 'getDirectoryHandle' || key === 'getFileHandle')
				return async (...args: unknown[]) =>
					holdable(await value.apply(target, args));
			if (key === 'getFile')
				return async (...args: unknown[]) => {
					const hold = heldRead;
					if (hold !== undefined && Reflect.get(target, 'name') === hold.name)
						await hold.until;
					return value.apply(target, args);
				};
			return value.bind(target);
		},
	});
}

/** Build the page and run its entry over a fresh in-memory OPFS. */
async function loadPage(outDir: string) {
	const config = canonicalViteConfig();
	await build({
		...config,
		logLevel: 'silent',
		base: './',
		build: { ...config.build, outDir, modulePreload: false },
	});
	const html = await readFile(join(outDir, 'index.html'), 'utf8');
	const entry = html.match(/<script type="module"[^>]*src="\.\/([^"]+)"/)?.[1];
	if (entry === undefined) throw new Error('The built page names no entry');

	const { window } = new JSDOM(html.replace(/<script[^>]*><\/script>/g, ''), {
		pretendToBeVisual: true,
		url: 'http://localhost:5181/',
	});
	window.confirm = () => true;
	for (const name of [
		'window',
		'document',
		'getComputedStyle',
		'requestAnimationFrame',
		'cancelAnimationFrame',
		'Node',
		'Element',
		'HTMLElement',
		'Text',
		'Comment',
		'DocumentFragment',
		'Event',
		'CustomEvent',
		'InputEvent',
		'MouseEvent',
		'FocusEvent',
		'HTMLInputElement',
		'HTMLTextAreaElement',
		'HTMLSelectElement',
		'MutationObserver',
	] as const)
		Object.defineProperty(globalThis, name, {
			configurable: true,
			writable: true,
			value: name === 'window' ? window : window[name],
		});
	const opfs = memoryOpfs();
	// The opener checks for writable streams before it uses the storage.
	Object.defineProperty(globalThis, 'FileSystemFileHandle', {
		configurable: true,
		value: class {
			createWritable() {}
		},
	});
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: {
			userAgent: window.navigator.userAgent,
			storage: { getDirectory: async () => holdable(await opfs.getDirectory()) },
			locks: createWebLocks(),
		},
	});
	await import(join(outDir, entry));
	return { window, opfs };
}

const outDir = await mkdtemp(join(tmpdir(), 'canonical-page-'));
let window: JSDOM['window'];
let opfs: MemoryOpfs;

async function waitFor(condition: () => boolean, ms = 15_000) {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) throw new Error(`Timed out. Log:\n${logText()}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Let any write an event admitted reach storage. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

function $<T extends Element>(selector: string): T {
	const found = window.document.querySelector<T>(selector);
	if (found === null) throw new Error(`Nothing matches ${selector}`);
	return found;
}
const logText = () => window.document.getElementById('log')?.textContent ?? '';
const logged = (text: string) => logText().includes(text);

function button(root: ParentNode, text: string) {
	const found = [...root.querySelectorAll('button')].find(
		(candidate) => candidate.textContent?.trim() === text,
	);
	if (found === undefined) throw new Error(`No button reads '${text}'`);
	return found;
}

const press = (element: Element) =>
	element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const click = (root: ParentNode, text: string) => press(button(root, text));

function choose(stem: string) {
	const select = $<HTMLSelectElement>('#owner select');
	select.value = stem;
	select.dispatchEvent(new window.Event('change', { bubbles: true }));
}
const selected = () => $<HTMLSelectElement>('#owner select').value;
const rawTarget = () => $('#raw p.warn').textContent;
const choicePending = () =>
	(window.document.getElementById('lifetime')?.childElementCount ?? 0) > 0;

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
	element.value = value;
	element.dispatchEvent(new window.Event('input', { bubbles: true }));
}

/** The text of a row file as the folder's storage holds it. */
function disk(stem: string): string | undefined {
	for (const [path, bytes] of opfs.files())
		if (path.endsWith(`/todos/${stem}.md`)) return decoder.decode(bytes);
	return undefined;
}

const owner = () => $('#owner');
const panel = (view: View) => $(`#${view}`);
/** Whether a view shows the Markdown source rather than the fields. */
function showsSource(view: View) {
	const source = panel(view).querySelector('textarea.source');
	return source !== null && source.closest('[hidden]') === null;
}
function titleInput(view: View) {
	const input = [...panel(view).querySelectorAll('input')].find(
		(candidate) => candidate.type !== 'checkbox',
	);
	if (input === undefined) throw new Error(`The ${view} view shows no title`);
	return input;
}

const journeys: [string, () => Promise<void>][] = [
	[
		'a control kept after its view unmounted submits nothing',
		async () => {
			const before = disk('plan');
			assert.match(before ?? '', /Plan the launch/);

			// Fields shown: the vanilla and Svelte titles and the Solid checkbox.
			const vanillaTitle = titleInput('vanilla');
			const svelteTitle = titleInput('svelte');
			const solidDone = $<HTMLInputElement>('#solid input[type=checkbox]');
			click(owner(), 'Unmount the views');
			assert.equal(panel('vanilla').childElementCount, 0);
			assert.equal(panel('svelte').childElementCount, 0);
			type(vanillaTitle, 'Detached vanilla title');
			type(svelteTitle, 'Detached Svelte title');
			solidDone.checked = true;
			solidDone.dispatchEvent(new window.Event('change', { bubbles: true }));
			await settle();
			assert.equal(disk('plan'), before);

			// Source shown: the vanilla and Svelte source textareas.
			click(owner(), 'Mount the views again');
			click(panel('vanilla'), 'Edit the Markdown source');
			click(panel('svelte'), 'Edit the Markdown source');
			await waitFor(() => showsSource('svelte'));
			const vanillaSource = $<HTMLTextAreaElement>('#vanilla textarea.source');
			const svelteSource = $<HTMLTextAreaElement>('#svelte textarea.source');
			click(owner(), 'Unmount the views');
			type(vanillaSource, '---\ntitle: Detached vanilla source\n---\n');
			type(svelteSource, '---\ntitle: Detached Svelte source\n---\n');
			await settle();
			assert.equal(disk('plan'), before);
			click(owner(), 'Mount the views again');
			click(panel('svelte'), 'Edit fields');
			await waitFor(() => !showsSource('svelte'));
			click(owner(), 'Unmount the views');

			click(owner(), 'Mount the views again');
			assert.equal(titleInput('solid').value, 'Plan the launch');
		},
	],
	[
		'each view keeps its own choice of fields or source across a remount',
		async () => {
			// The previous journey left vanilla on source.
			const modes = () => [
				showsSource('vanilla'),
				showsSource('solid'),
				showsSource('svelte'),
			];
			assert.deepEqual(modes(), [true, false, false]);
			click(panel('svelte'), 'Edit the Markdown source');
			click(panel('vanilla'), 'Edit fields');
			click(owner(), 'Unmount the views');
			click(owner(), 'Mount the views again');
			assert.deepEqual(modes(), [false, false, true]);
			click(panel('svelte'), 'Edit fields');
		},
	],
	[
		'while Reset holds a write, Open and another row are refused, and Reset opens the row it was asked with',
		async () => {
			const held = Promise.withResolvers<void>();
			let holding = true;
			opfs.faults.open = (path) =>
				holding && path.endsWith('/todos/plan.md') ? held.promise : undefined;

			click($('#reset'), 'Reset the demo rows…');
			await waitFor(() => logged('Released the editor for todos/plan.md'));
			await settle();
			// Reset is now writing plan.md, and that write is held.
			assert.equal(logged('Reset todos/plan.md to its seed text'), false);
			const select = $<HTMLSelectElement>('#owner select');
			select.value = 'tagged';
			select.dispatchEvent(new window.Event('change', { bubbles: true }));
			click(owner(), 'Open');
			assert.ok(logged('Open todos/tagged.md: refused while "Reset" runs'));
			assert.ok(logged('Open todos/plan.md: refused while "Reset" runs'));
			assert.equal(select.value, 'plan');
			assert.equal(panel('vanilla').childElementCount, 0);

			holding = false;
			held.resolve();
			await waitFor(() => logText().split('Opened todos/plan.md').length > 2);
			await settle();
			assert.equal(logged('Opening todos/tagged.md'), false);
			assert.equal(select.value, 'plan');
			assert.equal(titleInput('vanilla').value, 'Plan the launch');
			opfs.faults.open = undefined;
		},
	],
	[
		'after a failed save, the raw panel stays on its row until the input is discarded, and detached status controls do nothing',
		async () => {
			opfs.faults.write = (path) =>
				path.endsWith('/todos/plan.md') ? 'fail' : undefined;
			type(titleInput('vanilla'), 'Typed while failing');
			await waitFor(() => logged('Save failed'));
			// From here a write would land, so the checks below can see one.
			opfs.faults.write = undefined;
			const before = disk('plan');
			assert.match(before ?? '', /Plan the launch/);
			const status = $('#status');
			const retry = button(status, 'Save this text again');
			const probe = button(status, 'Subscribe probe');
			const readNow = button(status, 'Read the file again');
			const probeLog = status.querySelectorAll('ol.log')[0];
			if (probeLog === undefined) throw new Error('The status panel has no probe log');

			choose('urgent');
			await waitFor(choicePending);
			assert.equal(rawTarget(), 'Target: todos/plan.md');
			click($('#raw'), 'Load disk text');
			const rawText = $<HTMLTextAreaElement>('#raw textarea');
			await waitFor(() => rawText.value !== '');
			assert.match(rawText.value, /Plan the launch/);

			// The status panel unmounted with the views; its buttons are detached.
			assert.equal(status.childElementCount, 0);
			press(retry);
			press(probe);
			press(readNow);
			await settle();
			assert.equal(disk('plan'), before);
			assert.equal(probe.textContent, 'Subscribe probe');
			assert.equal(probeLog.childElementCount, 0);

			click($('#lifetime'), 'Keep editing');
			await waitFor(() => panel('vanilla').childElementCount > 0);
			assert.equal(selected(), 'plan');
			assert.equal(rawTarget(), 'Target: todos/plan.md');
			assert.equal(titleInput('vanilla').value, 'Typed while failing');

			choose('urgent');
			await waitFor(choicePending);
			assert.equal(rawTarget(), 'Target: todos/plan.md');
			click($('#lifetime'), 'Discard that input and open todos/urgent.md');
			await waitFor(() => logged('Opened todos/urgent.md'));
			assert.equal(selected(), 'urgent');
			await waitFor(() => rawTarget() === 'Target: todos/urgent.md');
			assert.equal(disk('plan'), before);
		},
	],
	[
		'a refused Open leaves a held acquisition running, and Close cancels one',
		async () => {
			const tagged = Promise.withResolvers<void>();
			heldRead = { name: 'tagged.md', until: tagged.promise };
			choose('tagged');
			await waitFor(() => logged('Opening todos/tagged.md'));
			await settle();
			choose('plan');
			click(owner(), 'Open');
			assert.ok(logged('Open todos/plan.md: refused while "Open todos/tagged.md" runs'));
			assert.equal(selected(), 'tagged');
			heldRead = undefined;
			tagged.resolve();
			await waitFor(() => logged('Opened todos/tagged.md'));
			assert.equal(logged('cancelled'), false);
			assert.ok(panel('vanilla').childElementCount > 0);

			const crlf = Promise.withResolvers<void>();
			heldRead = { name: 'crlf.md', until: crlf.promise };
			choose('crlf');
			await waitFor(() => logged('Opening todos/crlf.md'));
			await settle();
			click(owner(), 'Close');
			await waitFor(() => logged('Opening todos/crlf.md returned Aborted'));
			assert.ok(logged('Close: cancelled the acquisition for "Open todos/crlf.md"'));
			heldRead = undefined;
			crlf.resolve();
			await settle();
			assert.equal(logged('Opened todos/crlf.md'), false);
			assert.equal(panel('vanilla').childElementCount, 0);
		},
	],
];

let failed = false;
try {
	({ window, opfs } = await loadPage(outDir));
	await waitFor(() => logged('Opened todos/plan.md'));
	for (const [name, journey] of journeys) {
		try {
			await journey();
			console.log(`PASS ${name}`);
		} catch (cause) {
			console.log(`FAIL ${name}: ${cause instanceof Error ? cause.message : cause}`);
			failed = true;
			break;
		}
	}
} catch (cause) {
	console.log(`FAIL loading the page: ${cause instanceof Error ? cause.stack : cause}`);
	failed = true;
} finally {
	await rm(outDir, { recursive: true, force: true });
}
// The page keeps its folder open; end the process rather than wait on it.
process.exit(failed ? 1 : 0);
