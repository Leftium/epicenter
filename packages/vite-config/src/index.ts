import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { searchForWorkspaceRoot, type UserConfig } from 'vite';

/**
 * Base Vite config for SvelteKit workspace apps whose package contract and
 * browser composition live at the app root, outside `src/`.
 *
 * The `yjs` dedupe is load-bearing for CRDT identity. The `fs.allow` entry is
 * also load-bearing: setting it replaces Vite's default workspace-root
 * detection, so we recover that root explicitly to keep app-root exports and
 * sibling package source available in dev.
 */
export function workspaceAppViteConfig(app: { port: number }): UserConfig {
	return {
		plugins: [sveltekit(), tailwindcss()],
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
