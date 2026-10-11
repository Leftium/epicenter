/**
 * Mounts Matter's real Svelte components over a jsdom document in Bun tests.
 *
 * Patterned on `apps/todos/src/lib/svelte-dom.test-support.ts`. `.svelte`
 * components and `.svelte.ts` runes modules compile for the client the way the
 * Svelte Vite plugin compiles them; a compiler warning in this app's own files
 * fails the load, while other packages compile as they ship. `$lib/...` in
 * compiled modules resolves to `src/lib` as SvelteKit's alias does.
 *
 * Run with `bun run test:mounted`: it passes `--conditions=browser`, without
 * which `svelte` resolves to its server runtime, which cannot mount and whose
 * `SvelteMap` notifies nothing. Loading this module under other conditions
 * throws.
 *
 * jsdom is the copy `@epicenter/folder` installs for its own mounted tests;
 * Matter adds no dependency. jsdom implements no layout, focus order,
 * selection, or IME, so these tests prove what a delivered event or
 * CodeMirror transaction does, not how a person types.
 *
 * Import this module before anything that loads Svelte, then take Svelte's
 * runtime and components from a dynamic `import()`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { compile, compileModule } from 'svelte/compiler';

const appDir = join(import.meta.dir, '../..');
const libDir = join(appDir, 'src/lib');
const appSource = join(appDir, 'src');

/** Fail on a compiler warning in this app's own source; other packages compile as they ship. */
function check(path: string, warnings: readonly { message: string }[]) {
	if (!path.startsWith(appSource) || warnings.length === 0) return;
	throw new Error(
		`${path} compiled with warnings:\n${warnings.map((w) => w.message).join('\n')}`,
	);
}

/**
 * Point `$lib/...` specifiers at files, as SvelteKit's alias does. Matter
 * imports `$lib` modules without extensions, which Bun resolves before a
 * plugin's `onResolve` sees them, so compiled modules get absolute paths.
 */
function resolveLib(code: string) {
	return code.replace(/(['"])\$lib\/([^'"]+)\1/g, (_, quote, rest) => {
		const resolved = join(libDir, rest);
		const found = [resolved, `${resolved}.ts`].find(existsSync);
		if (found === undefined) throw new Error(`No module for $lib/${rest}`);
		return `${quote}${found}${quote}`;
	});
}

Bun.plugin({
	name: 'matter-svelte-dom',
	setup(build) {
		build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
			const compiled = compile(await Bun.file(path).text(), {
				filename: path,
				generate: 'client',
			});
			check(path, compiled.warnings);
			return { contents: resolveLib(compiled.js.code), loader: 'js' };
		});
		build.onLoad({ filter: /\.svelte\.(ts|js)$/ }, async ({ path }) => {
			const source = await Bun.file(path).text();
			const javascript = path.endsWith('.ts')
				? new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
				: source;
			const compiled = compileModule(javascript, {
				filename: path,
				generate: 'client',
			});
			check(path, compiled.warnings);
			return { contents: resolveLib(compiled.js.code), loader: 'js' };
		});
	},
});

/** The part of jsdom's surface this module uses; the app installs no jsdom types. */
type Jsdom = {
	JSDOM: new (
		html: string,
		options: { pretendToBeVisual: boolean; url: string },
	) => { window: Window & typeof globalThis };
};

// Loaded synchronously so the DOM globals exist before the importing test
// module evaluates; a top-level await here arrives too late.
const { JSDOM } = require(
	Bun.resolveSync('jsdom', join(appDir, '../../packages/folder')),
) as Jsdom;

const { window } = new JSDOM('<!doctype html><html><body></body></html>', {
	pretendToBeVisual: true,
	url: 'http://localhost/',
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
	'KeyboardEvent',
	'MouseEvent',
	'FocusEvent',
	'PointerEvent',
	'HTMLInputElement',
	'HTMLTextAreaElement',
	'HTMLButtonElement',
	'MutationObserver',
	'Range',
	'Selection',
	'getSelection',
	'localStorage',
] as const) {
	const value = name === 'window' ? window : window[name];
	if (value === undefined) continue;
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value:
			typeof value === 'function' && name.startsWith('get')
				? (value as (...args: unknown[]) => unknown).bind(window)
				: value,
	});
}
// Anything else the DOM offers that Bun lacks, such as `SVGElement`.
for (const name of Object.getOwnPropertyNames(window))
	if (!(name in globalThis))
		try {
			Object.defineProperty(globalThis, name, {
				configurable: true,
				writable: true,
				value: (window as unknown as Record<string, unknown>)[name],
			});
		} catch {
			// A property jsdom refuses to read outside its window stays absent.
		}
// The UI library asks for the color scheme; jsdom answers no query.
window.matchMedia ??= ((query: string) => ({
	matches: false,
	media: query,
	onchange: null,
	addListener() {},
	removeListener() {},
	addEventListener() {},
	removeEventListener() {},
	dispatchEvent: () => false,
})) as typeof window.matchMedia;
globalThis.matchMedia ??= window.matchMedia;
// jsdom lays nothing out; components that measure see nothing change.
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;
window.Element.prototype.animate ??= function animate() {
	const animation = {
		onfinish: null as (() => void) | null,
		playState: 'finished',
		currentTime: 0,
		effect: {},
		cancel() {},
		finished: Promise.resolve(),
	};
	queueMicrotask(() => animation.onfinish?.());
	return animation as unknown as Animation;
};
// CodeMirror measures text ranges after each update; jsdom's ranges have no boxes.
window.Range.prototype.getClientRects ??= () =>
	[] as unknown as ReturnType<Range['getClientRects']>;
window.Range.prototype.getBoundingClientRect ??= () =>
	({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;

if (!Bun.resolveSync('svelte', import.meta.dir).endsWith('index-client.js'))
	throw new Error(
		'Mounted Svelte tests need the browser runtime: run them with `bun run test:mounted`, which passes --conditions=browser.',
	);

/** Dispatch a click on the button whose text, or accessible label, is `name`. */
export function click(root: ParentNode, name: string) {
	const button = [...root.querySelectorAll('button')].find(
		(candidate) =>
			candidate.textContent?.trim() === name ||
			candidate.getAttribute('aria-label') === name,
	);
	if (button === undefined) throw new Error(`No button reads '${name}'`);
	button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}
