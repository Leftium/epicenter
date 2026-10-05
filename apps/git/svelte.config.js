import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
export default {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			pages: process.env.GIT_DESKTOP ? 'build-desktop' : 'build',
			assets: process.env.GIT_DESKTOP ? 'build-desktop' : 'build',
			fallback: 'index.html',
		}),
	},
};
