// Every build is a client-only static SPA. The browser build writes `build/`
// and keeps its folder in IndexedDB. Epicenter's build writes into the host's
// packaged asset tree, below the route the host serves it from, and reaches a
// real directory through the host.
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isEpicenterHost = process.env.EPICENTER_HOST === '1';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({
			...(isEpicenterHost && {
				pages: '../epicenter/dist/todos',
				assets: '../epicenter/dist/todos',
			}),
			fallback: 'index.html',
		}),
		...(isEpicenterHost && { paths: { base: '/apps/todos' } }),
	},
	preprocess: vitePreprocess(),
};

export default config;
