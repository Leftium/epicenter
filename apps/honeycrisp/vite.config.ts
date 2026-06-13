import { APPS } from '@epicenter/constants/apps';
import { workspaceAppFsAllow } from '@epicenter/constants/vite-config';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	resolve: {
		dedupe: ['yjs'],
	},
	server: {
		port: APPS.HONEYCRISP.port,
		strictPort: true,
		fs: { allow: workspaceAppFsAllow() },
	},
});
