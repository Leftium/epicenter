import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defaultClientConditions, defineConfig } from 'vite';

// Tauri sets TAURI_ENV_PLATFORM when it drives the build. Platform impls are
// selected by the `#platform/*` subpath imports in package.json: the Tauri build
// activates the `tauri` condition; the web build uses `default`. Custom
// conditions REPLACE Vite's defaults, so the `...defaultClientConditions` spread
// is load-bearing (drop it and dep resolution loses module/browser/dev|prod).
const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;

export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	resolve: {
		...(isTauri && { conditions: ['tauri', ...defaultClientConditions] }),
	},
	clearScreen: false,
	server: {
		// Tauri's devUrl points here; the port must be fixed.
		port: 5180,
		strictPort: true,
		watch: { ignored: ['**/src-tauri/**'] },
	},
});
