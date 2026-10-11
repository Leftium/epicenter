/** Compile UI modules so runtime tests exercise real Svelte tracking. */
import { compileModule } from 'svelte/compiler';

Bun.plugin({
	name: 'skills-svelte-tests',
	setup(build) {
		build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
			const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
				await Bun.file(path).text(),
			);
			return {
				contents: compileModule(javascript, {
					filename: path,
					generate: 'client',
				}).js.code,
				loader: 'js',
			};
		});
	},
});
