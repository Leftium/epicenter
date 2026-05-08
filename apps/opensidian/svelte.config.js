import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		alias: {
			'$platform/auth': './src/lib/platform/auth/bearer.ts',
			'#': '../../packages/ui/src',
		},
		adapter: staticAdapter({
			fallback: 'index.html',
		}),
	},
};

export default config;
