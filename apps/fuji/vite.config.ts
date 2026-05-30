import { APPS } from '@epicenter/constants/apps';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defaultClientConditions, defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;
const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;

export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	resolve: {
		dedupe: ['yjs'],
		// Platform impls are selected by the `#platform/*` subpath imports in
		// package.json. The Tauri build activates the `tauri` condition; the web
		// build uses `default`. Custom conditions REPLACE Vite's defaults, so the
		// `...defaultClientConditions` spread is load-bearing (drop it and all dep
		// resolution loses module/browser/dev|prod).
		...(isTauri && { conditions: ['tauri', ...defaultClientConditions] }),
	},
	clearScreen: false,
	server: {
		port: APPS.FUJI.port,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: 'ws',
					host,
					port: 5175,
				}
			: undefined,
		watch: {
			ignored: ['**/src-tauri/**'],
		},
	},
});
