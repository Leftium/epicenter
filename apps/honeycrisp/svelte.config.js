// Every build is a static SPA. The browser build writes `build/`. The desktop
// build writes `build-desktop/`, which the desktop shell bundles.
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isDesktop = process.env.HONEYCRISP_DESKTOP === '1';
const output = isDesktop ? 'build-desktop' : 'build';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({
			pages: output,
			assets: output,
			fallback: 'index.html',
		}),
	},
	preprocess: vitePreprocess(),
};

export default config;
