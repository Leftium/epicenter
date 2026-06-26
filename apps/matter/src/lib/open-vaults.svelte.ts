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
 * app-level tab set. The home is the app data dir, not a vault, because the open SET spans
 * vaults; it is session chrome, not any one vault's data. The store reads async, so the list
 * hydrates once via {@link ensureHydrated}. The `(vaults)` layout `load` awaits that before
 * any route in the group renders, so SvelteKit gates the paint on the real list: the strip
 * shows tabs with no skeleton and no pre-hydration flash, and an id resolves against the real
 * list, never a spurious 404. The framework's `load` IS the readiness primitive; there is no
 * hand-rolled `whenReady`/`hydrated` signal beside it.
 *
 * Replaces the old `vaultSession` singleton: where that held ONE `current` vault and
 * drove its lifetime, this holds only the list of tabs and the open/close actions.
 * SvelteKit's router owns everything else, so there is no `Map<id, TableHandle>`, no
 * `activeId`, and no manual dispose policy here.
 */

import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { LazyStore } from '@tauri-apps/plugin-store';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, tryAsync } from 'wellcrafted/result';
import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { routes } from '$lib/routes';

/** One open vault as persisted: an opaque id and the absolute vault-root path. The tab label is
 *  `basename(root)`, derived at render, not stored. */
const OpenVault = type({ id: 'string', root: 'string' });
export type OpenVault = typeof OpenVault.infer;

/** The persisted shape: the tab list, in order. Reading the store back through this is what
 *  turns a stale or hand-edited file into "no tabs" rather than a crash. */
const OpenVaultList = OpenVault.array();

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

function createOpenVaults() {
	const store = new LazyStore(STORE_FILE);
	// The list IS the tabs, in order. Empty until `ensureHydrated` fills it from disk.
	let vaults = $state<OpenVault[]>([]);
	let hydration: Promise<void> | undefined;

	// Read the persisted tabs from disk into the live list, once. The `(vaults)` layout `load`
	// awaits this before the group renders, so it is the readiness gate and the strip needs no
	// skeleton. Memoized on `hydration`, so however many loads await it, the read runs once.
	// `LazyStore.get()` loads the file on first access, so there is no separate `load()` step.
	// Two failure modes both degrade to no tabs: a malformed shape (rejected by `OpenVaultList`)
	// and an unreadable or corrupt file (`get()` rejects, caught here); either way the next
	// `open`/`close` rewrites a clean file. SSR has no Tauri runtime, so skip the read.
	function ensureHydrated(): Promise<void> {
		return (hydration ??= read());
	}
	async function read(): Promise<void> {
		if (!browser) return;
		const { data: raw, error } = await tryAsync({
			try: () => store.get(STORE_KEY),
			catch: (cause) => Err({ message: extractErrorMessage(cause) }),
		});
		// An unreadable or corrupt file (`get()` rejects) is "no tabs", like a fresh install.
		if (error) return;
		const restored = OpenVaultList(raw);
		if (!(restored instanceof type.errors)) vaults = restored;
	}

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
		await ensureHydrated();
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
		/** The open vaults, in tab order. Empty until {@link ensureHydrated} resolves. */
		get list(): OpenVault[] {
			return vaults;
		},
		/** Hydrate the list from disk, once. The `(vaults)` layout `load` and child page `load`s await it. */
		ensureHydrated,
		open,
		close,
		get,
	};
}

export const openVaults = createOpenVaults();
