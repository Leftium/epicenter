/**
 * Compiles `.svelte.ts` runes modules for Bun tests the way the Svelte Vite
 * plugin does. Import this first, then load runes modules with a dynamic
 * `import()` so the plugin is registered before they are loaded.
 *
 * The page build resolves `svelte/reactivity` to its client classes. Bun's
 * default conditions pick the server ones, which are plain collections that
 * notify nothing, so compiled modules import the client file directly and a
 * test sees the reactivity the page has.
 */
import { dirname, join } from 'node:path';
import { compileModule } from 'svelte/compiler';

const clientReactivity = join(
	dirname(Bun.resolveSync('svelte/package.json', import.meta.dir)),
	'src/reactivity/index-client.js',
);

Bun.plugin({
	name: 'svelte-runes-module',
	setup(build) {
		build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
			const typescript = await Bun.file(path).text();
			const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
				typescript,
			);
			const compiled = compileModule(javascript, {
				filename: path,
				generate: 'client',
			});
			return {
				contents: compiled.js.code.replaceAll(
					/(['"])svelte\/reactivity\1/g,
					JSON.stringify(clientReactivity),
				),
				loader: 'js',
			};
		});
	},
});
