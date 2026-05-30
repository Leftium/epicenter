import { APPS } from '@epicenter/constants/apps';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defaultClientConditions, defineConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';

const host = process.env.TAURI_DEV_HOST;
const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
	plugins: [sveltekit(), tailwindcss(), devtoolsJson()],
	resolve: {
		dedupe: ['yjs'],
		// Build-time platform DI. Each `#platform/*` subpath (package.json
		// "imports") has a browser impl and a Tauri impl; the Tauri build
		// activates the `tauri` condition, the web build uses `default`
		// (browser). A Tauri-only file imported by shared code is unresolvable
		// under the web condition, so it fails at vite build time, not at user
		// runtime. The `...defaultClientConditions` spread is load-bearing:
		// custom conditions REPLACE Vite's defaults.
		...(isTauri && { conditions: ['tauri', ...defaultClientConditions] }),
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
