import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { searchForWorkspaceRoot, type UserConfig } from 'vite';

/**
 * Base Vite config for SvelteKit workspace apps whose package contract and
 * browser composition live at the app root, outside `src/`.
 *
 * The `yjs` dedupe is load-bearing for CRDT identity.
 *
 * The `fs.allow` entry is load-bearing too, but not because of Vite's own
 * default. @sveltejs/kit's plugin sets fs.allow to the app `src/`, the app and
 * workspace-root `node_modules`, and its own output, and nothing else. That
 * omits the monorepo root, so the app-root composition files (the package
 * contract and browser entry that live outside `src/`) and sibling-package
 * source are unreadable in dev. Adding the workspace root restores both; Vite
 * concatenates it with SvelteKit's entries rather than replacing them.
 */
export function workspaceAppViteConfig(app: { port: number }): UserConfig {
	return {
		// A consuming app's `@sveltejs/kit` and this package can resolve different
		// bun peer-variant copies of the same `vite` version (`vite@7.3.5` vs
		// `vite@7.3.5+<hash>`), whose `Plugin` types are then nominally unrelated,
		// so `svelte-check` rejects the array against this package's `UserConfig`.
		// One vite runs at runtime; bridge the array to this package's plugin type.
		plugins: [sveltekit(), tailwindcss()] as UserConfig['plugins'],
		resolve: {
			dedupe: ['yjs'],
		},
		server: {
			port: app.port,
			strictPort: true,
			fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
		},
	};
}
