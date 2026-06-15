import { searchForWorkspaceRoot } from 'vite';

/**
 * `server.fs.allow` for a workspace app whose package contract (`<app>.ts`)
 * and browser composition (`<app>.browser.ts`) live at the app root, outside
 * `src/`, as the app's `.` / `./browser` package exports.
 *
 * SvelteKit's default fs.allow does not reach app-root files, so dev requests
 * for them (e.g. `/<app>.browser.ts`) are denied with a 403 Restricted without
 * this entry. Note: setting `allow` REPLACES the default, so it must also span
 * sibling workspace package source served over `/@fs`; the workspace root
 * covers both. Narrowing to just the app dir (`process.cwd()`) serves the
 * app-root modules but re-breaks sibling packages, so use the workspace root.
 */
export function workspaceAppFsAllow(): string[] {
	return [searchForWorkspaceRoot(process.cwd())];
}
