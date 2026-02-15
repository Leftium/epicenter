import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	srcDir: 'src',
	modules: ['@wxt-dev/module-svelte'],
	manifest: {
		name: 'Tab Manager',
		description: 'Manage browser tabs with Epicenter',
		permissions: ['tabs', 'storage'],
		// host_permissions needed for favicons and tab info
		host_permissions: ['<all_urls>'],
	},
	vite: () => ({
		plugins: [tailwindcss()],
		resolve: {
			dedupe: ['yjs'],
			alias: {
				$lib: resolve(__dirname, 'src/lib'),
			},
		},
	}),
});
