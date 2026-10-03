/**
 * EXPERIMENT launcher for the canonical editor callers page. From the
 * repository root:
 *
 *     bun packages/folder/evidence/edit-handle/canonical-dev.ts
 *
 * It serves `canonical-web/` with Vite on port 5181 (or `PORT`). There is no
 * server folder: the page runs the editor over an in-memory harness folder,
 * so nothing outside the browser tab is read or written.
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
		// Solid compiles `.tsx`; Svelte compiles `.svelte`. Plain `.ts` is neither's.
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
