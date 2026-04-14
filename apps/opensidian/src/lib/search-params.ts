/**
 * URL search param state utility for Opensidian.
 *
 * Provides a single function to update URL search params via SvelteKit's
 * `goto()`. Default values are elided from the URL to keep it clean—`/`
 * means all defaults. Uses `replaceState` to avoid polluting browser history.
 */

import { goto } from '$app/navigation';
import { page } from '$app/state';

/**
 * Update a single URL search param, removing it when `null` to keep URLs clean.
 *
 * Uses `replaceState` so switching files or conversations doesn't create
 * a new history entry for every click. `keepFocus` preserves cursor
 * position in inputs.
 *
 * @example
 * ```typescript
 * setSearchParam('file', fileId);
 * setSearchParam('chat', conversationId);
 * setSearchParam('file', null); // clear
 * ```
 */
export function setSearchParam(key: string, value: string | null) {
	const params = new URLSearchParams(page.url.searchParams);
	if (value === null) {
		params.delete(key);
	} else {
		params.set(key, value);
	}
	const search = params.toString();
	goto(`${page.url.pathname}${search ? `?${search}` : ''}${page.url.hash}`, {
		replaceState: true,
		noScroll: true,
		keepFocus: true,
	});
}
