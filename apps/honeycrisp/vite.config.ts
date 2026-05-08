import { APPS } from '@epicenter/constants/apps';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type ConfigEnv } from 'vite';

export default defineConfig(({ command, mode }) => {
	return {
		plugins: [sveltekit(), tailwindcss()],
		resolve: {
			alias: {
				'$platform/auth': fileURLToPath(
					new URL(selectAuthModule({ command, mode }), import.meta.url),
				),
			},
			dedupe: ['yjs'],
		},
		server: {
			port: APPS.HONEYCRISP.port,
			strictPort: true,
		},
	};
});

function selectAuthModule({
	command,
	mode,
}: Pick<ConfigEnv, 'command' | 'mode'>) {
	// Hosted browser production can rely on the API cookie jar.
	if (command === 'build' && mode === 'production') {
		return './src/lib/platform/auth/cookie.ts';
	}

	// Local browser runs on a different origin, so it owns a bearer session.
	return './src/lib/platform/auth/bearer.ts';
}
