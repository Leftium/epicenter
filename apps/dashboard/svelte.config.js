import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({
			pages: 'build/dashboard',
			assets: 'build/dashboard',
			fallback: 'index.html',
		}),
		paths: {
			base: '/dashboard',
		},
		alias: {
			'$platform/auth': selectAuthModule(),
			'#': '../../packages/ui/src',
		},
	},
	preprocess: vitePreprocess(),
};

export default config;

function selectAuthModule() {
	// SvelteKit feeds this alias to Vite and generated TypeScript config.
	if (process.env.NODE_ENV === 'production') {
		return './src/lib/platform/auth/cookie.ts';
	}

	return './src/lib/platform/auth/bearer.ts';
}
