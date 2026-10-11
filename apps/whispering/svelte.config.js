// A client-only SPA. The desktop app serves `build/` from its folder host and
// the same build runs in a browser tab over a logical folder. The Epicenter
// build writes into that host's packaged asset tree under its route.
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isEpicenterHost = process.env.EPICENTER_HOST === '1';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({
			...(isEpicenterHost && {
				pages: '../epicenter/dist/whispering',
				assets: '../epicenter/dist/whispering',
			}),
			fallback: 'index.html', // SPA fallback for dynamic routes
		}),
		...(isEpicenterHost && { paths: { base: '/apps/whispering' } }),
		// No `csp` block: adapter-static only emits an enforcing meta tag. The
		// desktop folder host sends the policy as a header (native/host.ts), and
		// the web deploy uses `static/_headers`.
	},

	preprocess: vitePreprocess(),
};

export default config;
