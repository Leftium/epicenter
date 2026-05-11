import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({
			fallback: 'index.html',
		}),
		alias: {
			$routes: './src/routes',
			'$platform/auth': selectAuthModule(),
		},
	},
	preprocess: vitePreprocess(),
};

export default config;

function selectAuthModule() {
	// kit.alias is the source of truth for Vite and generated TypeScript config.
	if (process.env.NODE_ENV === 'production') {
		return './src/lib/platform/auth/cookie.ts';
	}

	return './src/lib/platform/auth/bearer.ts';
}
