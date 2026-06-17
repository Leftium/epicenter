/**
 * A live Vault: one directory of typed markdown Tables, read as one relational unit.
 *
 * This is the layer above {@link createTable}. A Table watches ONE folder's files; a Vault watches
 * the ROOT for table folders appearing and disappearing (`watch_vault`, depth-1), and composes a
 * `createTable` per child folder. It owns its Tables' lifetimes: dispose the Vault and every Table
 * watch and the root watch stop. The Vault declares nothing itself: it is the live union of its
 * Tables' self-declared contracts, discovered, not configured.
 *
 * Why this exists: references only have meaning across two Tables of the SAME Vault
 * (`adaptations.page -> pages`), so resolution is a Vault-level operation. The Vault holds every
 * Table together, runs `assess` over all of them at once, and exposes ONE live {@link
 * VaultIntegrity} that the grid, the Table switcher, and the integrity panel all select from. The
 * single open table case is just a degenerate Vault of one Table.
 *
 * Desktop-only: it talks to Tauri directly (no platform seam), mirroring {@link createTable}.
 */

import { Channel, invoke } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import { assess, type VaultIntegrity } from './core/integrity';
import { createTable, type TableHandle } from './table.svelte';

/** The vault root's own folder name (its basename), for the tab label. */
const basename = (path: string) => path.split(/[/\\]/).pop() ?? path;

/**
 * Open `root` as a live vault. Synchronous and IO-free: the table set starts empty and fills from
 * the first membership snapshot once the root watch is armed, so there is no separate initial
 * listing and no list-then-watch gap (the Rust side arms before its seed scan).
 */
export function createVault(root: string) {
	const vaultName = basename(root);

	// child folder path -> its live Table. The membership snapshot from `watch_vault` reconciles
	// this map; the `tables` getter sorts by name so the switcher and integrity read a stable
	// order regardless of when a folder was added.
	const tables = new SvelteMap<string, TableHandle>();

	/**
	 * Reconcile the live tables against a fresh membership snapshot (the whole child-folder list):
	 * dispose the folders that left, compose the folders that arrived, leave the rest untouched so
	 * an unrelated change (a loose file written at the root) churns nothing.
	 */
	function reconcile(paths: string[]): void {
		// A membership snapshot can still arrive after dispose (the seed, or a debounced batch
		// already in flight when the tab closed): ignore it, or it would arm a fresh per-folder
		// watch with nothing left to dispose it. Mirrors the same `disposed` guard the watch-id
		// path below already honors.
		if (disposed) return;
		const incoming = new Set(paths);
		for (const [path, table] of tables) {
			if (incoming.has(path)) continue;
			table.dispose();
			tables.delete(path);
		}
		for (const path of paths) {
			if (!tables.has(path)) tables.set(path, createTable(path));
		}
	}

	/** The vault's tables, sorted by folder name: the stable order every surface renders in. */
	const orderedTables = $derived(
		[...tables.values()].sort((a, b) =>
			a.folderName.localeCompare(b.folderName),
		),
	);

	/**
	 * The one composed integrity model, recomputed whenever any table's read changes or the table
	 * set changes. Every readable table contributes itself (folder name + classified read) to
	 * `assess`, which resolves references across them; an unreadable folder never reaches here (the
	 * root watch only lists folders it could stat as directories). The grid, the switcher's
	 * per-table badges, and the integrity panel are all pure selectors over this.
	 */
	const integrity = $derived.by(
		(): VaultIntegrity =>
			assess(
				orderedTables.map((table) => ({
					name: table.folderName,
					status: 'readable' as const,
					read: table.read,
				})),
			),
	);

	// Opening a vault IS observing it: arm the root watch now. `watch_vault` seeds the current
	// membership, then streams a snapshot per change, all through `reconcile`. `whenReady` resolves
	// once the watch is armed (the seed scan finished before the invoke resolved) and rejects if it
	// could not be armed; the shell gates on it with `{#await}`.
	const channel = new Channel<string[]>();
	channel.onmessage = reconcile;
	let watchId: number | undefined;
	let disposed = false;
	const whenReady = invoke<number>('watch_vault', { path: root, channel }).then(
		(id) => {
			if (disposed) void invoke('unwatch_vault', { id });
			else watchId = id;
		},
	);

	/** Stop the root watch AND every composed table watch. The keyed route component calls this on teardown. */
	function dispose(): void {
		disposed = true;
		if (watchId !== undefined) void invoke('unwatch_vault', { id: watchId });
		for (const table of tables.values()) table.dispose();
		tables.clear();
	}

	return {
		vaultName,
		root,
		whenReady,
		dispose,
		/** The vault's live tables, sorted by folder name. A pure read with no side effects. */
		get tables(): TableHandle[] {
			return orderedTables;
		},
		/** The one composed integrity model across every table. Read it reactively. */
		get integrity(): VaultIntegrity {
			return integrity;
		},
	};
}

export type VaultHandle = ReturnType<typeof createVault>;
