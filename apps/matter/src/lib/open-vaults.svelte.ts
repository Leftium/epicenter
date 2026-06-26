/**
 * The set of open vaults: the tabs.
 *
 * Multi-vault state is split three ways, and this file owns only the durable slice.
 * WHICH vault is active lives in the URL (`/vault/[id]`); the LIVE watcher lives in
 * the route component (construct on mount, dispose on destroy). All that is left is
 * WHICH vault roots are open: a small persisted list of `{ id, root }` that survives
 * relaunch so the tabs come back. The `id` is opaque and URL-safe so the route can carry
 * it; `/vault/[id]` resolves it back to a `root` via {@link get}. The tab LABEL is not
 * stored: it is `basename(root)`, derived where it renders, so there is no cached copy to
 * keep in sync with the path.
 *
 * Persisted to `open-vaults.json` in the app data dir via `tauri-plugin-store`, a plain
 * inspectable file on disk rather than an opaque webview blob: the same disk-is-truth
 * principle as matter's per-vault `matter.json` / `.matter/matter.sqlite`, applied to the
 * app-level tab set. The store reads async, so the list hydrates: it starts empty, the file
 * loads in the background, and `hydrated` flips true once the persisted tabs land. `whenReady`
 * is the promise the route `load` awaits so an id resolves against the real list, never a
 * spurious 404.
 *
 * Replaces the old `vaultSession` singleton: where that held ONE `current` vault and
 * drove its lifetime, this holds only the list of tabs and the open/close actions.
 * SvelteKit's router owns everything else, so there is no `Map<id, TableHandle>`, no
 * `activeId`, and no manual dispose policy here.
 */

import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { LazyStore } from '@tauri-apps/plugin-store';
import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { routes } from '$lib/routes';

/** One open vault as persisted: an opaque id and the absolute vault-root path. The tab label is
 *  `basename(root)`, derived at render, not stored. */
export type OpenVault = { id: string; root: string };

const STORE_FILE = 'open-vaults.json';
const STORE_KEY = 'vaults';

/** Prompt for a folder; `null` if the dialog was cancelled. */
async function openFolderDialog(): Promise<string | null> {
	const path = await openDialog({
		directory: true,
		multiple: false,
		title: 'Open vault folder',
	});
	// A folder path is a string; null (cancel), an array (multi-select), or anything
	// else a future plugin version might return is "no pick".
	if (typeof path !== 'string') return null;
	return path;
}

/** Is `value` a list we can trust? A corrupt or stale store degrades to no tabs. */
function isOpenVaultList(value: unknown): value is OpenVault[] {
	return (
		Array.isArray(value) &&
		value.every(
			(entry): entry is OpenVault =>
				typeof entry === 'object' &&
				entry !== null &&
				typeof (entry as OpenVault).id === 'string' &&
				typeof (entry as OpenVault).root === 'string',
		)
	);
}

function createOpenVaults() {
	const store = new LazyStore(STORE_FILE);
	// The list IS the tabs, in order. Empty until the async store hydrates it below.
	let vaults = $state<OpenVault[]>([]);
	let hydrated = $state(false);

	// Read the persisted tabs once at startup. `LazyStore.get()` loads the file on first
	// access, so there is no separate `load()` step; a missing or malformed file degrades
	// to no tabs. SSR/prerender has no Tauri runtime, so skip the read and just mark ready.
	async function hydrate(): Promise<void> {
		if (!browser) {
			hydrated = true;
			return;
		}
		try {
			const raw = await store.get<OpenVault[]>(STORE_KEY);
			if (isOpenVaultList(raw)) vaults = raw;
		} catch {
			// A failed read is "no tabs", same as a fresh install.
		}
		hydrated = true;
	}
	const whenReady = hydrate();

	// Persist the tabs. A fire-and-forget side effect: the store auto-saves 100ms after a
	// `set` (the plugin default), so no caller awaits the disk write, and a dropped write
	// only forgets a tab, never real data. `$state.snapshot` hands the store a plain array,
	// not the reactive proxy.
	function persist(): void {
		void store.set(STORE_KEY, $state.snapshot(vaults)).catch(() => {});
	}

	/**
	 * Open a vault root as a tab and navigate to it. Opening is always a user action: the
	 * native picker cannot be triggered from a URL, so this mints the id the URL will
	 * carry. Reopening a root already in the list focuses its existing tab instead of
	 * duplicating it (tabs show one at a time and only the active one is live, so a
	 * second tab on the same root would be a dead duplicate).
	 */
	async function open(): Promise<void> {
		const root = await openFolderDialog();
		if (root === null) return;
		await whenReady;
		const existing = vaults.find((vault) => vault.root === root);
		if (existing) {
			await goto(routes.vault(existing.id));
			return;
		}
		// Opaque, URL-safe, collision-free: the URL carries this, not the raw path (paths
		// contain `/` and special chars that are fragile in a URL).
		const vault: OpenVault = {
			id: crypto.randomUUID(),
			root,
		};
		vaults = [...vaults, vault];
		persist();
		await goto(routes.vault(vault.id));
	}

	/**
	 * Remove a tab. Navigating away from a closed ACTIVE tab is the caller's job (the
	 * tab strip's `closeTab` navigates to a neighbor). That is what keeps the invariant
	 * "the viewed id is always in the list" true: the route's `load` resolves id -> root
	 * once and is not reactive to this list, so a removal that did NOT navigate would
	 * leave a now-orphaned vault live until the next navigation.
	 */
	function close(id: string): void {
		vaults = vaults.filter((vault) => vault.id !== id);
		persist();
	}

	/** Resolve an id back to its open vault, or `undefined` if it is not open. */
	function get(id: string): OpenVault | undefined {
		return vaults.find((vault) => vault.id === id);
	}

	return {
		/** The open vaults, in tab order. Empty until {@link hydrated}. */
		get list(): OpenVault[] {
			return vaults;
		},
		/** True once the persisted list has loaded; gates the tab strip's skeleton. */
		get hydrated(): boolean {
			return hydrated;
		},
		/** Resolves once the persisted list has loaded; the route `load` awaits it. */
		whenReady,
		open,
		close,
		get,
	};
}

export const openVaults = createOpenVaults();
