/**
 * A live view over a folder on disk.
 *
 * The folder is the truth and other processes write it (agents, your editor, git),
 * so the vault is not a one-shot read: a single `watch_folder` command arms a
 * native folder watcher (backed by `notify`), pushes the folder's current
 * contents as a first batch, then streams a batch per debounced change. Each
 * pushed delta is self-contained ({@link FileDelta}: a name plus the file's
 * observable state), so the JS never round-trips a separate read, and seed and
 * update flow through ONE path (`applyDeltas`). `createSubscriber` runs the watch
 * only while something observes the vault, and tears it down otherwise (closing
 * the page stops the OS watcher).
 *
 * Desktop-only: it talks to Tauri directly (no platform seam). Develop with
 * `bun run tauri dev`.
 */

import { invoke, Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { createSubscriber, SvelteMap } from 'svelte/reactivity';
import {
	buildView,
	type FolderRead,
	loadModel,
	MatterReadError,
	type UnreadableFile,
} from './model/view';
import { parseMarkdown } from './model/parse';
import type { Row } from './model/types';

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
 * Open `path` as a live vault. Synchronous and IO-free: the maps start empty and
 * the first pushed batch seeds them on first observe, so there is no separate
 * initial read and no read-then-watch gap.
 */
function createVault(path: string) {
	const name = basename(path);

	// Keyed by filename: a single file's change touches only its entry.
	const rows = new SvelteMap<string, Row>();
	const unreadable = new SvelteMap<string, UnreadableFile['error']>();
	let modelText = $state<string | undefined>(undefined);
	// 'loading' until the first batch lands, so an empty grid is never confused
	// with a real empty folder; `error` is set if the watch itself fails.
	let status = $state<'loading' | 'ready'>('loading');
	let error = $state<string | undefined>(undefined);
	// Memoized: Schema.Compile runs only when matter.json changes, not on every
	// .md change. A single-file change reclassifies against these cached columns.
	const loaded = $derived(loadModel(modelText));

	/** Parse one file into the readable rows or the unreadable list. */
	function ingest(fileName: string, content: string) {
		const { data, error } = parseMarkdown(content);
		if (error) {
			unreadable.set(fileName, error);
			rows.delete(fileName);
			return;
		}
		rows.set(fileName, { name: fileName, ...data });
		unreadable.delete(fileName);
	}

	/** Apply one pushed batch to the in-memory maps (the seed and every update). */
	function applyDeltas(deltas: FileDelta[]) {
		for (const delta of deltas) {
			if (delta.name === 'matter.json') {
				// A removed or unreadable model is no model: degrade to the raw view.
				modelText = delta.kind === 'content' ? delta.text : undefined;
				continue;
			}
			switch (delta.kind) {
				case 'content':
					ingest(delta.name, delta.text);
					break;
				case 'removed':
					rows.delete(delta.name);
					unreadable.delete(delta.name);
					break;
				case 'unreadable':
					rows.delete(delta.name);
					// `.error` is the bare tagged error (the factory returns an `Err`),
					// matching what the parse path stores from its destructured Result.
					unreadable.set(delta.name, MatterReadError.Undecodable().error);
					break;
			}
		}
	}

	// The watch is live only while the vault is observed (createSubscriber's
	// start/stop lifecycle); reading any of `read` / `status` / `error` activates it.
	const subscribe = createSubscriber((update) => {
		const channel = new Channel<FileDelta[]>();
		let watchId: number | undefined;
		let cancelled = false;
		channel.onmessage = (deltas) => {
			applyDeltas(deltas);
			status = 'ready';
			update();
		};
		invoke<number>('watch_folder', { path, channel })
			.then((id) => {
				// Torn down before the id arrived: drop the watcher that just
				// resolved instead of leaking it.
				if (cancelled) void invoke('unwatch_folder', { id });
				else watchId = id;
			})
			.catch((cause) => {
				error = cause instanceof Error ? cause.message : String(cause);
				status = 'ready';
				update();
			});
		return () => {
			cancelled = true;
			if (watchId !== undefined) void invoke('unwatch_folder', { id: watchId });
		};
	});

	return {
		name,
		path,
		/** The current classified folder. Reading it activates the watch. */
		get read(): FolderRead {
			subscribe();
			const currentRows = [...rows.values()];
			return {
				rows: currentRows,
				unreadable: [...unreadable].map(([name, error]) => ({
					name,
					error,
				})),
				view: buildView(currentRows, loaded),
			};
		},
		/** Whether the first batch has landed. Reading it activates the watch. */
		get status(): 'loading' | 'ready' {
			subscribe();
			return status;
		},
		/** Set if the watch could not be established. Reading it activates the watch. */
		get error(): string | undefined {
			subscribe();
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
