import { defineConfig } from 'jsrepo';

export default defineConfig({
	registries: ['@ieedan/shadcn-svelte-extras'],
	/**
	 * Path configuration for jsrepo (shadcn-svelte-extras).
	 *
	 * IMPORTANT: These paths must align with components.json aliases for shadcn-svelte.
	 * Both CLIs install a utils.ts file, and they MUST write to the same location.
	 *
	 * How it works:
	 * - shadcn-svelte uses components.json "aliases.utils" to determine utils.ts location
	 * - jsrepo uses this "paths.lib" because the utils item has type "lib" (not "util")
	 *
	 * Current alignment:
	 * - components.json: "utils": "#/utils" → resolves to src/utils.ts
	 * - jsrepo.config.ts: "lib": "src" → utils.ts written to src/utils.ts
	 *
	 * The utils/ FOLDER (containing casing.ts, is-letter.ts) uses type "util",
	 * which maps to paths.util = "src/utils" → src/utils/casing.ts
	 */
	paths: {
		ui: 'src',
		lib: 'src',
		util: 'src/utils',
		hook: 'src/hooks',
		hooks: 'src/hooks',
	},
});
