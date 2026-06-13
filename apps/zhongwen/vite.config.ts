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
			// exports. SvelteKit's default fs.allow does not reach app-root files,
			// so dev requests for them (e.g. `/zhongwen.browser.ts`) are denied with
			// a 403 Restricted without this entry. Note: setting `allow` REPLACES
			// the default, so it must also span sibling workspace package source
			// (`packages/*`) served over `/@fs`; the workspace root covers both.
			// Narrowing this to just the app dir (`process.cwd()`) re-breaks those
			// siblings, so keep the workspace root.
			allow: [searchForWorkspaceRoot(process.cwd())],
		},
	},
});
