import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';

// The browser folder's Git runs on isomorphic-git, which expects Node's
// Buffer. `@epicenter/folder` owns that dependency, so resolve it from there.
const fromFolder = createRequire(
	pathToFileURL(fileURLToPath(import.meta.resolve('@epicenter/folder'))).href,
);

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.WHISPERING), {
		plugins: [devtoolsJson()],
		resolve: {
			alias: [
				// The page opens a folder only in a browser tab; the desktop app
				// reaches its folder through the folder host. So the page is built
				// against the browser entry, and no desktop adapter is emitted. The
				// exact bare specifier only: subpaths are left alone.
				{
					find: /^@epicenter\/folder$/,
					replacement: '@epicenter/folder/browser',
				},
				// The package directory, so both `buffer` and `buffer/` resolve.
				{ find: 'buffer', replacement: dirname(fromFolder.resolve('buffer/')) },
				// just-bash's browser bundle imports gzip helpers the terminal never enables.
				{
					find: 'node:zlib',
					replacement: fileURLToPath(
						new URL('./src/lib/shims/zlib.ts', import.meta.url),
					),
				},
			],
		},
		server: { host: '127.0.0.1' },
		optimizeDeps: { include: ['buffer'] },
	}),
);
