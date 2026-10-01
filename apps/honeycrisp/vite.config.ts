import { fileURLToPath } from 'node:url';
import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defaultClientConditions, defineConfig, mergeConfig } from 'vite';

/** The desktop page: served by the folder host, reaching a real directory. */
const isDesktop = process.env.HONEYCRISP_DESKTOP === '1';

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.HONEYCRISP), {
		resolve: {
			// Build-time selection over `#platform/notes-host` in package.json
			// "imports". The spread is load-bearing: custom conditions REPLACE
			// Vite's defaults.
			...(isDesktop && {
				conditions: ['tauri', ...defaultClientConditions],
			}),
			alias: {
				// isomorphic-git and its SHA-1 dependency expect Node's Buffer.
				buffer: fileURLToPath(import.meta.resolve('buffer/')),
				// just-bash's browser bundle imports gzip helpers the terminal never enables.
				'node:zlib': fileURLToPath(
					new URL('./src/lib/shims/zlib.ts', import.meta.url),
				),
			},
		},
		optimizeDeps: { include: ['buffer'] },
	}),
);
