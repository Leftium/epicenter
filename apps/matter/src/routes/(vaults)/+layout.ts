import { openVaults } from '$lib/open-vaults.svelte';
import type { LayoutLoad } from './$types';

/**
 * The readiness gate for the whole `(vaults)` group. Hydrating the open-vault list is async
 * (a Tauri store read), and SvelteKit blocks a route's render until its loads resolve, so
 * awaiting it here means every `(vaults)` route paints against the real list: the tab strip
 * needs no skeleton, and a child `load` that forgets to await hydration still renders after
 * it. Hydration is memoized, so this shares one read with the child page `load`s.
 */
export const load: LayoutLoad = async () => {
	await openVaults.ensureHydrated();
};
