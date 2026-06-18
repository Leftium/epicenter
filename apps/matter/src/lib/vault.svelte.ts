/**
 * A live Vault: one directory of typed markdown Tables, read as one relational unit.
 *
 * This is the layer above {@link createTable}. A Table watches ONE folder's files; a Vault watches
 * the ROOT (`watch_vault`, depth-1) for its table set changing, and composes a `createTable` per
 * table the watcher resolves. `watch_vault` applies the same table-or-vault rule as the CLI loader
 * (`load/fs.ts` `loadPath`), where altitude is pure shape: a folder of folders is a vault of those
 * Tables, while a folder of files (or an empty folder) is itself a single Table on the root, so
 * opening a leaf folder and opening a parent both work. A `matter.json` only types a Table; it never
 * decides altitude. It owns its Tables' lifetimes:
 * dispose the Vault and every Table watch and the root watch stop. The Vault declares nothing
 * itself: it is the live union of its Tables' self-declared contracts, discovered, not configured.
 *
 * Why this exists: references only have meaning across two Tables of the SAME Vault
 * (`adaptations.page -> pages`), so resolution is a Vault-level operation. The Vault holds every
 * Table together, runs `assess` over all of them at once, and exposes ONE live {@link
 * VaultIntegrity} that the grid, the Table switcher, and the integrity panel all select from. The
 * single open table case is just a degenerate Vault of one Table.
 *
 * The Vault is also the SOLE owner of the SQLite mirror: one hidden `<root>/.matter/matter.sqlite`
 * holding one SQL table per folder (named for the folder), so an agent or SQL console can JOIN
 * across the whole vault (`FROM pages JOIN adaptations`). The Vault resets that db on open, rewrites
 * one table's slice when its `onChange` fires, and drops a table when its folder leaves the set. The
 * mirror is a PROJECTION only: `assess` owns every reference verdict; SQL never resolves references.
 *
 * Desktop-only: it talks to Tauri directly (no platform seam), mirroring {@link createTable}.
 */

import { Channel, invoke } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, type Result, tryAsync } from 'wellcrafted/result';
import { assess, type VaultIntegrity } from './core/integrity';
import { basename, join } from './core/path';
import { projectToSqlite, quoteIdent } from './core/sqlite';
import { createTable, type TableHandle } from './table.svelte';

/**
 * Open `root` as a live vault. Synchronous and IO-free: the table set starts empty and fills from
 * the first table list once the root watch is armed, so there is no separate initial listing and no
 * list-then-watch gap (the Rust side arms before its seed scan).
 */
export function createVault(root: string) {
	const folderName = basename(root);

	// The vault's hidden mirror dir. One `matter.sqlite` lives here holding one SQL table per
	// folder; content folders stay pure markdown (classification skips dot-dirs, so `.matter/`
	// is never mistaken for a table, even in a one-table vault where the root IS the folder).
	const matterDir = join(root, '.matter');

	// Fresh db on open (rule 3): make `.matter/` and delete a stale `matter.sqlite` before any
	// table writes its slice, so a folder gone since last session leaves no stale SQL table. Every
	// deferred mirror write awaits this, so a seed rebuild can never land before the reset clears
	// the file.
	const whenReset = invoke('reset_mirror', { path: matterDir }).catch(() => {});

	// Bumped after each mirror write or drop. The WHERE filter reads it to re-query only once the
	// shared `.matter` db is fresh, rather than the moment the in-memory rows change (which lead the
	// file by the async rebuild). Read-side reactivity is fine; the write TRIGGER stays a callback.
	let mirrorVersion = $state(0);

	// table folder path -> its live Table. The table list from `watch_vault` reconciles this map;
	// the `tables` getter sorts by name so the switcher and integrity read a stable order
	// regardless of when a folder was added.
	const tables = new SvelteMap<string, TableHandle>();

	/**
	 * Project one table's current rows into its SQL table in the shared `.matter` mirror, off the UI
	 * task (the grid is already current from the watcher batch). The Table fires `onChange` per batch
	 * and this adapter does the SQLite work, so the rebuild trigger stays imperative and at its source
	 * (the batch), not laundered through a reactive effect. A typed folder rebuilds (full DROP + CREATE
	 * + INSERT, a pure function of the folder, self-healing); an untyped one has no contract, so its
	 * table is dropped instead (rule 4). Bumps `mirrorVersion` on success so the WHERE filter re-queries
	 * a fresh file. Fire-and-forget: a failure self-heals on the next batch.
	 */
	function scheduleMirrorWrite(path: string): void {
		setTimeout(async () => {
			await whenReset; // never write before the open-time reset cleared the db
			const table = tables.get(path);
			if (!table) return; // left (and was dropped) before this deferred write ran
			const { folderName: name, read } = table;
			if (read.view.mode === 'typed') {
				const { schema, insert, rows } = projectToSqlite(
					name,
					read.view.contract,
					read.view.conformance,
				);
				void invoke('write_mirror', { path: matterDir, schema, insert, rows })
					.then(() => mirrorVersion++)
					.catch(() => {});
			} else {
				void invoke('drop_mirror_table', { path: matterDir, table: name })
					.then(() => mirrorVersion++)
					.catch(() => {});
			}
		}, 0);
	}

	/**
	 * Reconcile the live tables against a fresh table list (the whole set `watch_vault` resolved,
	 * which is the child folders, or the root itself when the root is a single table): dispose the
	 * folders that left, compose the folders that arrived, leave the rest untouched so an unrelated
	 * change (a loose file written at the root) churns nothing.
	 */
	function reconcile(paths: string[]): void {
		// A snapshot can still arrive after dispose (the seed, or a debounced batch already in flight
		// when the tab closed): ignore it, or it would arm a fresh per-folder watch with nothing left
		// to dispose it. Mirrors the same `disposed` guard the watch-id path below already honors.
		if (disposed) return;
		const incoming = new Set(paths);
		for (const [path, table] of tables) {
			if (incoming.has(path)) continue;
			const { folderName: name } = table;
			table.dispose();
			tables.delete(path);
			// The folder left the set: drop its SQL table so it does not linger in the shared db
			// (rule 2). Fire-and-forget and idempotent (DROP TABLE IF EXISTS).
			void invoke('drop_mirror_table', { path: matterDir, table: name })
				.then(() => mirrorVersion++)
				.catch(() => {});
		}
		for (const path of paths) {
			if (!tables.has(path)) {
				// The onChange adapter (fired per watcher batch) writes this table's mirror slice.
				tables.set(
					path,
					createTable(path, () => scheduleMirrorWrite(path)),
				);
			}
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

	/**
	 * Run a WHERE clause against one folder's SQL table in the shared `.matter` mirror and return the
	 * matching file names. The ONE query seam the per-tab WHERE filter calls: the table name is quoted
	 * through {@link quoteIdent} and the clause is the user's own raw SQL against their own read-only
	 * local db, so the worst a bad clause does is return an error. No limit: a name-only filter returns
	 * every match, never a silent cap.
	 */
	function queryTable(
		name: string,
		where: string,
	): Promise<Result<Set<string>, { message: string }>> {
		const sql = `SELECT "file" FROM ${quoteIdent(name)} WHERE ${where}`;
		return tryAsync({
			try: async () => {
				const { rows } = await invoke<{ columns: string[]; rows: unknown[][] }>(
					'query_mirror',
					{ path: matterDir, sql, limit: null },
				);
				return new Set(rows.map((row) => String(row[0])));
			},
			catch: (cause) => Err({ message: extractErrorMessage(cause) }),
		});
	}

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
		folderName,
		root,
		whenReady,
		dispose,
		queryTable,
		/** The vault's live tables, sorted by folder name. A pure read with no side effects. */
		get tables(): TableHandle[] {
			return orderedTables;
		},
		/** The one composed integrity model across every table. Read it reactively. */
		get integrity(): VaultIntegrity {
			return integrity;
		},
		/** Increments after each mirror write or drop. Read it (reactively) to re-query once the
		 *  shared `.matter` db is fresh, rather than the moment the in-memory rows change. */
		get mirrorVersion(): number {
			return mirrorVersion;
		},
	};
}

export type VaultHandle = ReturnType<typeof createVault>;
