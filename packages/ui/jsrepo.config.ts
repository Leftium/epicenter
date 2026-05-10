import { defineConfig } from 'jsrepo';

export default defineConfig({
	registries: ['@ieedan/shadcn-svelte-extras'],
	/**
	 * Path configuration for jsrepo (shadcn-svelte-extras).
	 *
	 * These are filesystem targets, not import aliases. Keep them explicit so
	 * jsrepo can install files without reintroducing a private UI source alias.
	 *
	 * shadcn-svelte still needs import aliases in its generator-only config.
	 * Source files under src must use relative imports after generated components
	 * are reviewed.
	 */
	paths: {
		ui: './src',
		lib: './src',
		util: './src/utils',
		hook: './src/hooks',
		hooks: './src/hooks',
	},
});
