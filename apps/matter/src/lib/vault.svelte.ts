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
import {
	buildView,
	type FolderRead,
	loadModel,
	MatterReadError,
	type ParsedEntry,
	parseEntry,
} from './model/view';

/**
 * One file's observable state, pushed by `watch_folder` (serde `tag = "kind"`).
 * `content` carries the bytes so the JS never re-reads; `removed` drops the row;
 * `unreadable` (non-UTF-8 / permission) routes to "Can't read" instead of
 * vanishing.
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

	// ONE store, keyed by filename: each entry is either a parsed row or the error
	// that stopped it. `set` replaces, so "a name is readable XOR unreadable" is
	// structural, not an invariant maintained by hand across two maps.
	const files = new SvelteMap<string, ParsedEntry>();
	let modelText = $state<string | undefined>(undefined);
	// 'loading' until the watch is established. The seed scan finishes before
	// `watch_folder` resolves, so its resolution (not the first batch) flips this,
	// which means an EMPTY folder still reaches 'ready' instead of hanging.
	let status = $state<'loading' | 'ready'>('loading');
	let error = $state<string | undefined>(undefined);
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
					// `.error` is the bare tagged error (the factory returns an `Err`),
					// matching what `parseEntry` stores from its destructured Result.
					files.set(delta.name, {
						ok: false,
						error: MatterReadError.Undecodable().error,
					});
					break;
			}
		}
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
		/** The current classified folder. A pure read with no side effects. */
		get read(): FolderRead {
			const rows: FolderRead['rows'] = [];
			const unreadable: FolderRead['unreadable'] = [];
			for (const [fileName, entry] of files) {
				if (entry.ok) rows.push(entry.row);
				else unreadable.push({ name: fileName, error: entry.error });
			}
			return { rows, unreadable, view: buildView(rows, loaded) };
		},
		/** Whether the watch has been established (or failed). */
		get status(): 'loading' | 'ready' {
			return status;
		},
		/** Set if the watch could not be established. */
		get error(): string | undefined {
			return error;
		},
	};
}

export type Vault = ReturnType<typeof createVault>;

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
