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
			'$platform/auth': './src/lib/platform/auth/auth.ts',
			// Sibling Worker code (billing contracts, BILLING_ROUTES, BillingError).
			// Avoids `../../../../worker/...` and makes the deployment seam visible:
			// the UI knows it is bundled with this Worker, not a third-party API.
			$api: '../worker',
		},
	},
	preprocess: vitePreprocess(),
};

export default config;
