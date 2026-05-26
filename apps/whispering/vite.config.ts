import { APPS } from '@epicenter/constants/apps';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';

const host = process.env.TAURI_DEV_HOST;
const isTauri = process.env.TAURI_PLATFORM !== undefined;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
	plugins: [sveltekit(), tailwindcss(), devtoolsJson()],
	resolve: {
		dedupe: ['yjs'],
		// Build-time platform DI. Tauri builds resolve `.tauri.ts` first;
		// web builds resolve `.browser.ts` first. Files with no suffix
		// (plain `.ts`) are platform-neutral and resolve on both builds
		// as the fallback. A Tauri-only file (`<svc>.tauri.ts` with no
		// `.browser.ts` companion) is unresolvable on web, so any web
		// bundle that statically imports it fails at vite build time
		// instead of at user runtime.
		extensions: isTauri
			? ['.tauri.ts', '.tauri.js', '.ts', '.js', '.json']
			: ['.browser.ts', '.browser.js', '.ts', '.js', '.json'],
	},
	// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
	//
	// 1. prevent vite from obscuring rust errors
	clearScreen: false,
	// 2. tauri expects a fixed port, fail if that port is not available
	server: {
		port: APPS.AUDIO.port,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: 'ws',
					host,
					port: 1421,
				}
			: undefined,
		watch: {
			// 3. tell vite to ignore watching `src-tauri`
			ignored: ['**/src-tauri/**'],
		},
	},
}));
