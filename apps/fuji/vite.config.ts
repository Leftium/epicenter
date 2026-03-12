import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
	plugins: [
		sveltekit(),
		tailwindcss(),
		nodePolyfills({
			globals: { Buffer: true },
		}),
	],
	resolve: {
		dedupe: ['yjs'],
	},
});
