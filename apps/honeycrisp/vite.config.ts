import { APPS } from '@epicenter/constants/apps';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	resolve: {
		dedupe: ['yjs'],
	},
	server: {
		port: APPS.HONEYCRISP.port,
		strictPort: true,
		proxy: process.env.VITE_API_URL
			? {
					'/auth': {
						target: process.env.VITE_API_URL,
						changeOrigin: true,
					},
					'/workspaces': {
						target: process.env.VITE_API_URL,
						changeOrigin: true,
						ws: true,
					},
				}
			: undefined,
	},
});
