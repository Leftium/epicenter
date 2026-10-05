/**
 * Mounts real Svelte components over a jsdom document in Bun tests.
 *
 * `.svelte` components and `.svelte.ts` runes modules compile for the client
 * the way the Svelte Vite plugin compiles them, and a compiler warning fails
 * the load. The tests run with `--conditions=browser` so `svelte` resolves to
 * the client runtime a page build uses; Bun's default conditions select the
 * server runtime, which cannot mount and whose `createSubscriber` notifies
 * nothing. Loading this module under other conditions throws.
 *
 * jsdom implements no Web Animations, which Svelte transitions run on. The
 * `animate` stand-in here finishes delays at once and holds every timed
 * animation until `finishAnimations`, so a test can act on a node while its
 * outro keeps it in the document. It times nothing; layout, focus, selection,
 * and IME behavior are not exercised by these tests.
 *
 * Import this module before anything that loads Svelte, then take Svelte's
 * runtime from its exports and load components with a dynamic `import()`.
 */
import { JSDOM } from 'jsdom';
import { compile, compileModule } from 'svelte/compiler';

const { window } = new JSDOM('<!doctype html><html><body></body></html>', {
	pretendToBeVisual: true,
});

for (const name of [
	'window',
	'document',
	'navigator',
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
	'MutationObserver',
] as const) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value: name === 'window' ? window : window[name],
	});
}

type HeldAnimation = {
	onfinish: (() => void) | null;
	currentTime: number;
	playState: 'running' | 'finished' | 'idle';
	effect: unknown;
	cancel(): void;
};

const heldAnimations = new Set<HeldAnimation>();

window.Element.prototype.animate = function animate(
	_keyframes: unknown,
	options?: number | KeyframeAnimationOptions,
) {
	const duration =
		typeof options === 'number' ? options : Number(options?.duration ?? 0);
	const animation: HeldAnimation = {
		onfinish: null,
		currentTime: 0,
		playState: 'running',
		effect: {},
		cancel() {
			animation.playState = 'idle';
			heldAnimations.delete(animation);
		},
	};
	if (duration > 0) heldAnimations.add(animation);
	else
		queueMicrotask(() => {
			if (animation.playState !== 'running') return;
			animation.playState = 'finished';
			animation.onfinish?.();
		});
	return animation as unknown as Animation;
};

/** Finish every timed animation, such as an outro keeping a node in the document. */
export function finishAnimations() {
	for (const animation of [...heldAnimations]) {
		heldAnimations.delete(animation);
		animation.playState = 'finished';
		animation.onfinish?.();
	}
}

if (!Bun.resolveSync('svelte', import.meta.dir).endsWith('index-client.js'))
	throw new Error(
		'Mounted Svelte tests need the browser runtime: run them with `bun run test:svelte`, which passes --conditions=browser.',
	);

function assertNoWarnings(
	path: string,
	warnings: readonly { message: string }[],
) {
	if (warnings.length > 0)
		throw new Error(
			`${path} compiled with warnings:\n${warnings.map((w) => w.message).join('\n')}`,
		);
}

Bun.plugin({
	name: 'folder-svelte-dom',
	setup(build) {
		build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
			const compiled = compile(await Bun.file(path).text(), {
				filename: path,
				generate: 'client',
			});
			assertNoWarnings(path, compiled.warnings);
			return { contents: compiled.js.code, loader: 'js' };
		});
		build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
			const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
				await Bun.file(path).text(),
			);
			const compiled = compileModule(javascript, {
				filename: path,
				generate: 'client',
			});
			assertNoWarnings(path, compiled.warnings);
			return { contents: compiled.js.code, loader: 'js' };
		});
	},
});

/** Set a field's value and dispatch the `input` event a keystroke would. */
export function type(element: Element | null, value: string) {
	if (
		!(element instanceof window.HTMLInputElement) &&
		!(element instanceof window.HTMLTextAreaElement)
	)
		throw new Error('Expected an input or a textarea');
	element.value = value;
	element.dispatchEvent(new window.Event('input', { bubbles: true }));
}

/** Dispatch a click on a button found by its text. */
export function click(root: ParentNode, text: string) {
	const button = [...root.querySelectorAll('button')].find(
		(candidate) => candidate.textContent?.trim() === text,
	);
	if (button === undefined) throw new Error(`No button reads '${text}'`);
	button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}
