/** EXPERIMENT: the Vite configuration `dev.ts` serves and `build.ts` builds. */
import { join } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { InlineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export function demoViteConfig(): InlineConfig {
	return {
		configFile: false,
		root: join(import.meta.dir, 'web'),
		// Solid compiles `.tsx`; Svelte compiles `.svelte`. Plain `.ts` is neither's.
		plugins: [solid(), svelte()],
		build: {
			outDir: join(import.meta.dir, 'dist'),
			emptyOutDir: true,
			target: 'esnext',
		},
	};
}
