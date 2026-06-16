// Tauri doesn't have a Node.js server to do proper SSR
// so we will use adapter-static to prerender the app (SSG)
// This works for both Tauri and Cloudflare Workers + Assets
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({
			fallback: 'index.html', // SPA fallback for dynamic routes
		}),
		alias: {
			$routes: './src/routes',
		},
	},

	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	vitePlugin: {
		inspector: {
			// This block owns dev-tooling behavior, not geometry. The toggle
			// inherits the plugin default 'top-right', the corner left free by
			// the current chrome (sidebar on the left, full-width BottomNav at
			// the bottom). The app must never reposition #svelte-inspector-host:
			// earlier CSS overrides keyed to nav z-index broke twice when the nav
			// changed. To move or disable it per-machine, set an env var instead
			// (the plugin gives it top precedence), e.g.
			// SVELTE_INSPECTOR_OPTIONS='{"toggleButtonPos":"top-left"}'
			holdMode: true,
			showToggleButton: 'always',
			toggleKeyCombo: 'alt-x',
		},
	},
};

export default config;
