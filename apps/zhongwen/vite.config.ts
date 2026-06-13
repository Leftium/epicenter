import { APPS } from '@epicenter/constants/apps';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	server: {
		port: APPS.ZHONGWEN.port,
		strictPort: true,
		fs: {
			// The workspace contract (`zhongwen.ts`) and browser composition
			// (`zhongwen.browser.ts`) live at the app root, outside `src/`, because
			// they are the `@epicenter/zhongwen` package's `.` / `./browser`
			// exports. SvelteKit's default fs.allow only reaches `src/` and
			// node_modules, so dev requests for those app-root modules 404 without
			// this. Allowing the monorepo root covers them plus sibling workspace
			// package source.
			allow: [searchForWorkspaceRoot(process.cwd())],
		},
	},
});
