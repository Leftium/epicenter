/**
 * Launcher for the row editor callers page. From the repository root:
 *
 *     bun packages/folder/evidence/edit-handle/canonical-dev.ts
 *
 * It serves `canonical-web/` with Vite on port 5181 (or `PORT`). There is no
 * server folder: the page opens the persisted demo folder in the browser's
 * own storage with the production browser opener. The folder belongs to the
 * page's origin, so keep the same host and port to see the same files.
 */
import { join } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createServer, type InlineConfig } from 'vite';
import solid from 'vite-plugin-solid';

/** The Vite configuration this launcher serves and `canonical-build.ts` builds. */
export function canonicalViteConfig(): InlineConfig {
	return {
		configFile: false,
		root: join(import.meta.dir, 'canonical-web'),
		// Solid compiles `.tsx`; Svelte compiles `.svelte` and `.svelte.ts`.
		// The Svelte plugin dedupes `svelte`, so the package's adapter
		// (`src/svelte`) runs on this directory's Svelte, the panel's runtime,
		// rather than the repository's second copy.
		plugins: [solid(), svelte()],
		build: {
			outDir: join(import.meta.dir, 'dist-canonical'),
			emptyOutDir: true,
			target: 'esnext',
		},
	};
}

if (import.meta.main) {
	const server = await createServer({
		...canonicalViteConfig(),
		server: {
			host: 'localhost',
			port: Number(process.env.PORT ?? 5181),
			strictPort: true,
		},
	});
	await server.listen();
	server.printUrls();
}
