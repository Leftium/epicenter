import { APPS } from '@epicenter/constants/apps';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	resolve: {
		alias: {
			'$platform/auth': fileURLToPath(
				new URL('./src/lib/platform/auth/cookie.ts', import.meta.url),
			),
		},
		dedupe: ['yjs'],
	},
	server: {
		port: APPS.FUJI.port,
		strictPort: true,
	},
});
