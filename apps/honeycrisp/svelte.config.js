// Every build is a static SPA. The browser build writes `build/`. The desktop
// build writes `build-desktop/`, which the folder host serves. Epicenter's
// build writes into its packaged asset tree below its loopback route.
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isEpicenterHost = process.env.EPICENTER_HOST === '1';
const isDesktop = process.env.HONEYCRISP_DESKTOP === '1';
const output = isEpicenterHost
	? '../epicenter/dist/honeycrisp'
	: isDesktop
		? 'build-desktop'
		: 'build';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({
			pages: output,
			assets: output,
			fallback: 'index.html',
		}),
		...(isEpicenterHost && { paths: { base: '/apps/honeycrisp' } }),
	},
	preprocess: vitePreprocess(),
};

export default config;
