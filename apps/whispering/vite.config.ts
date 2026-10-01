import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';

// The browser folder's Git runs on isomorphic-git, which expects Node's
// Buffer. `@epicenter/app` owns that dependency, so resolve it from there.
const fromApp = createRequire(
	pathToFileURL(fileURLToPath(import.meta.resolve('@epicenter/app/files')))
		.href,
);

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.WHISPERING), {
		plugins: [devtoolsJson()],
		resolve: {
			alias: {
				// The package directory, so both `buffer` and `buffer/` resolve.
				buffer: dirname(fromApp.resolve('buffer/')),
				// just-bash's browser bundle imports gzip helpers the terminal never enables.
				'node:zlib': fileURLToPath(
					new URL('./src/lib/shims/zlib.ts', import.meta.url),
				),
			},
		},
		server: { host: '127.0.0.1' },
		optimizeDeps: { include: ['buffer'] },
	}),
);
