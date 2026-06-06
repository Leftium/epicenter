/**
 * A live view over a folder on disk.
 *
 * The folder is the truth and other processes write it (agents, your editor, git),
 * so the vault is not a one-shot read: a single `watch_folder` command arms a
 * native folder watcher (backed by `notify`), pushes the folder's current
 * contents as a first batch, then streams a batch per debounced change. Each
 * pushed delta is self-contained ({@link FileDelta}: a name plus the file's
 * observable state), so the JS never round-trips a separate read, and seed and
 * update flow through ONE path (`applyDeltas`) into ONE `SvelteMap`.
 *
 * Lifecycle is explicit: `watch()` starts the OS watcher and returns a stop
 * function, and the page drives it with `$effect(() => vault.watch())` so
 * switching folders stops the old watcher. The getters (`read` / `status` /
 * `error`) are pure, so reading them never starts anything.
 *
 * Desktop-only: it talks to Tauri directly (no platform seam). Develop with
 * `bun run tauri dev`.
 */

import { invoke, Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { SvelteMap } from 'svelte/reactivity';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, type Result, tryAsync } from 'wellcrafted/result';
import { editBody, editField } from './core/serialize';
import { projectToSqlite } from './core/sqlite';
import {
	buildView,
	type FolderRead,
	loadModel,
	MatterReadError,
	type UnreadableFile,
} from './core/folder';
import { parseEntry, type Row } from './core/parse';

/**
 * One file's observable state, pushed by `watch_folder` (serde `tag = "kind"`).
 * `content` carries the bytes so the JS never re-reads; `removed` drops the row;
 * `unreadable` (non-UTF-8 / permission) routes to "Can't read" instead of
 * vanishing.
 *
 * Hand-mirrored from the Rust `FileDelta` enum in `src-tauri/src/watch.rs`: keep
 * the variants, field names, and `tag: 'kind'` in lockstep, or live updates break
 * silently at runtime. (Swap for `tauri-specta` codegen once the IPC surface grows.)
 */
type FileDelta =
	| { kind: 'content'; name: string; text: string }
	| { kind: 'removed'; name: string }
	| { kind: 'unreadable'; name: string };

/** The vault's own folder name (its basename). Per-file paths are Rust's. */
const basename = (path: string) => path.split(/[/\\]/).pop() ?? path;

/**
 * Open `path` as a live vault. Synchronous and IO-free: the store starts empty
 * and fills from the first pushed batch once `watch()` runs, so there is no
 * separate initial read and no read-then-watch gap.
 */
function createVault(path: string) {
	const name = basename(path);

	// ONE store, keyed by filename: each entry is a `Result` that is either a
	// parsed row or the error that stopped it. `set` replaces, so "a name is
	// readable XOR unreadable" is structural, not an invariant kept by hand across
	// two maps.
	const files = new SvelteMap<string, Result<Row, UnreadableFile['error']>>();
	let modelText = $state<string | undefined>(undefined);
	// 'loading' until the watch is established. The seed scan finishes before
	// `watch_folder` resolves, so its resolution (not the first batch) flips this,
	// which means an EMPTY folder still reaches 'ready' instead of hanging.
	let status = $state<'loading' | 'ready'>('loading');
	let error = $state<string | undefined>(undefined);
	// Set when the LAST save could not reach disk. A save never mutates the store
	// (that is the watcher's job); this is the only state a write touches.
	let writeError = $state<string | undefined>(undefined);
	// Set when the LAST matter.sqlite reconcile failed. The index is a derived read
	// surface, so a failure never blocks the grid; it is surfaced for diagnostics.
	let indexError = $state<string | undefined>(undefined);
	// Memoized: Schema.Compile runs only when matter.json changes, not on every
	// .md change. A single-file change reclassifies against these cached columns.
	const loaded = $derived(loadModel(modelText));

	/** Apply one pushed batch to the store (the seed and every update). */
	function applyDeltas(deltas: FileDelta[]) {
		for (const delta of deltas) {
			if (delta.name === 'matter.json') {
				// A removed or unreadable model is no model: degrade to the raw view.
				modelText = delta.kind === 'content' ? delta.text : undefined;
				continue;
			}
			switch (delta.kind) {
				case 'content':
					files.set(delta.name, parseEntry(delta.name, delta.text));
					break;
				case 'removed':
					files.delete(delta.name);
					break;
				case 'unreadable':
					// `Undecodable()` already returns an `Err`, so it stores directly as
					// the file's failed `Result` (no row, the read-level error).
					files.set(delta.name, MatterReadError.Undecodable());
					break;
			}
		}
		// Rebuild the read-only SQLite mirror once per batch, off the UI task: the grid is
		// already current from the map mutations above, so defer the (potentially large)
		// projection with setTimeout so it never delays paint. Per-batch, not debounced:
		// the native watcher already coalesces a burst into one batch, and a rebuild that
		// lands after teardown just writes that folder's own final truth.
		setTimeout(reconcileIndex, 0);
	}

	/**
	 * The current classified folder, derived from the files map + the loaded model.
	 * The ONE place "files map -> FolderRead" lives, MEMOIZED so the `read` getter (the
	 * UI surface) and `reconcileIndex` (the SQLite mirror) share a single classification
	 * instead of each recomputing it. Recomputes only when `files` or the loaded model
	 * changes; `reconcileIndex` reads it when its deferred rebuild runs, so it sees the
	 * latest classification rather than a stale snapshot.
	 */
	const read = $derived.by((): FolderRead => {
		const rows: FolderRead['rows'] = [];
		const unreadable: FolderRead['unreadable'] = [];
		for (const [fileName, { data, error }] of files) {
			if (error) unreadable.push({ name: fileName, error });
			else rows.push(data);
		}
		return { rows, unreadable, view: buildView(rows, loaded) };
	});

	/**
	 * Reconcile `<path>/matter.sqlite` from the current VALID rows: a FULL
	 * DROP + CREATE + INSERT, so the file is a pure function of the folder (self-healing,
	 * no incremental drift to debug, no stale row an agent could read). The SvelteMap
	 * stays the live in-app surface; this file is the EXTERNAL one. An unmodeled folder
	 * has no typed table, so it is skipped. Fire-and-forget: a failure surfaces in
	 * `indexError` (cleared only on success, so it reflects the last completed rebuild)
	 * and never blocks the grid. The JS projector builds all the SQL; the Rust
	 * `write_index` command only executes it and binds the rows.
	 *
	 * A full rebuild (not an incremental sync) is deliberate: benchmarks keep it well
	 * under a frame to ~50k rows, it runs off the UI task (scheduled with setTimeout from
	 * `applyDeltas`), and for an agent read surface "pure function of truth" is a safety
	 * property, not just simplicity.
	 */
	function reconcileIndex(): void {
		const { view } = read;
		if (view.mode !== 'modeled') return;
		const { schema, insert, rows: tuples } = projectToSqlite(
			name,
			view.model,
			view.conformance,
		);
		void invoke('write_index', { path, schema, insert, rows: tuples })
			.then(() => {
				indexError = undefined;
			})
			.catch((cause) => {
				indexError = extractErrorMessage(cause);
			});
	}

	/**
	 * Apply one edit to a file on disk: read the freshest bytes, transform them in
	 * JS, write atomically. A command in the CQRS sense, NOT a store mutation, the
	 * written file fires the watcher and returns as a delta, and THAT is what
	 * updates the map. So the map stays a pure projection and "what the UI shows"
	 * still provably equals "what is on disk", even for the app's own writes.
	 *
	 * Reading at write time (rather than caching raw text in the store) keeps the
	 * edit faithful to the current bytes and keeps the store a parsed read-model
	 * with no second copy to drift.
	 */
	async function write(name: string, edit: (raw: string) => string) {
		writeError = undefined;
		const { error: failure } = await tryAsync({
			try: async () => {
				const raw = await invoke<string | null>('read_entry', { path, name });
				await invoke('write_entry', { path, name, content: edit(raw ?? '') });
			},
			catch: (cause) => Err({ message: extractErrorMessage(cause) }),
		});
		if (failure) writeError = failure.message;
	}

	/**
	 * Set or clear one frontmatter field (`value === undefined` clears it). The
	 * transform ({@link editField}) is applied to a FRESH parse of disk, not the
	 * (possibly debounce-stale) projection, so a concurrent external edit to another
	 * field is read, not clobbered.
	 */
	function saveField(name: string, key: string, value: unknown): Promise<void> {
		return write(name, (raw) => editField(raw, key, value));
	}

	/** Replace a file's body, keeping its frontmatter values intact. */
	function saveBody(name: string, body: string): Promise<void> {
		return write(name, (raw) => editBody(raw, body));
	}

	/**
	 * Start watching the folder; returns a stop function. The page owns the
	 * lifecycle via `$effect(() => vault.watch())`, so switching folders unwatches
	 * the old folder automatically.
	 */
	function watch(): () => void {
		const channel = new Channel<FileDelta[]>();
		let watchId: number | undefined;
		let stopped = false;
		channel.onmessage = applyDeltas;
		invoke<number>('watch_folder', { path, channel })
			.then((id) => {
				// The seed scan ran before this resolved, so the watch is established
				// (even for an empty folder): mark ready.
				status = 'ready';
				// Stopped before the id arrived: drop the watcher that just resolved.
				if (stopped) void invoke('unwatch_folder', { id });
				else watchId = id;
			})
			.catch((cause) => {
				error = cause instanceof Error ? cause.message : String(cause);
				status = 'ready';
			});
		return () => {
			stopped = true;
			if (watchId !== undefined) void invoke('unwatch_folder', { id: watchId });
		};
	}

	return {
		name,
		path,
		watch,
		saveField,
		saveBody,
		/** The current classified folder. A pure read with no side effects. */
		get read(): FolderRead {
			return read;
		},
		/** Whether the watch has been established (or failed). */
		get status(): 'loading' | 'ready' {
			return status;
		},
		/** Set if the watch could not be established. */
		get error(): string | undefined {
			return error;
		},
		/** Set if the most recent save could not reach disk. */
		get writeError(): string | undefined {
			return writeError;
		},
		/** Set if the most recent matter.sqlite reconcile failed (diagnostic only). */
		get indexError(): string | undefined {
			return indexError;
		},
	};
}

export type Vault = ReturnType<typeof createVault>;

/**
 * The slice of a {@link Vault} the grid renders from: the folder name, the
 * classified read, and the two save commands. This is the dependency boundary
 * `FolderGrid` depends on, NOT the full vault, so anything that can produce a
 * classified folder and accept edits can drive the grid. The live vault satisfies
 * it for free (it is a `Pick` of it); the demo vault satisfies it WITHOUT faking
 * the disk lifecycle (`watch` / `status` / `path`), so the demo is an honest
 * drop-in rather than a vault pretending to watch a folder.
 */
export type FolderGridVault = Pick<Vault, 'name' | 'read' | 'saveField' | 'saveBody'>;

/** Prompt for a folder and open it as a live {@link Vault}. `null` if cancelled. */
export async function openVault(): Promise<Vault | null> {
	const path = await open({
		directory: true,
		multiple: false,
		title: 'Open vault folder',
	});
	if (path === null || Array.isArray(path)) return null;
	return createVault(path);
}
