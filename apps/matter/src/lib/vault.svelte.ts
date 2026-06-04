/**
 * A live view over a folder on disk.
 *
 * The folder is the truth and other processes write it (agents, your editor, git),
 * so the vault is not a one-shot read: a single `watch_folder` command arms a
 * native folder watcher (backed by `notify`), pushes the folder's current
 * contents as a first batch, then streams a batch per debounced change. Each
 * pushed delta is self-contained ({@link FileDelta}: a name plus the file's
 * observable state), so the JS never round-trips a separate read, and seed and
 * update flow through ONE path ({@link Vault.#applyDeltas}). `createSubscriber`
 * runs the watch only while something observes the vault, and tears it down
 * otherwise (closing the page stops the OS watcher).
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
	type UnreadableFile,
} from './model/folder';
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

export class Vault {
	/** The folder's display name (its basename). */
	readonly name: string;
	/** The folder's absolute path. */
	readonly path: string;

	// Keyed by filename: a single file's change touches only its entry.
	#rows = new SvelteMap<string, Row>();
	#unreadable = new SvelteMap<string, UnreadableFile['reason']>();
	#modelText = $state<string | undefined>(undefined);
	// 'loading' until the first batch lands, so an empty grid is never confused
	// with a real empty folder; `#error` is set if the watch itself fails.
	#status = $state<'loading' | 'ready'>('loading');
	#error = $state<string | undefined>(undefined);
	#subscribe: () => void;

	constructor(path: string) {
		this.path = path;
		this.name = basename(path);

		// The watch is live only while the vault is observed (createSubscriber's
		// start/stop lifecycle). The seed arrives as the first pushed batch, so
		// there is no separate initial read and no read-then-watch gap.
		this.#subscribe = createSubscriber((update) => {
			const channel = new Channel<FileDelta[]>();
			let watchId: number | undefined;
			let cancelled = false;
			channel.onmessage = (deltas) => {
				this.#applyDeltas(deltas);
				this.#status = 'ready';
				update();
			};
			invoke<number>('watch_folder', { path, channel })
				.then((id) => {
					// Torn down before the id arrived: drop the watcher that just
					// resolved instead of leaking it.
					if (cancelled) void invoke('unwatch_folder', { id });
					else watchId = id;
				})
				.catch((error) => {
					this.#error = error instanceof Error ? error.message : String(error);
					this.#status = 'ready';
					update();
				});
			return () => {
				cancelled = true;
				if (watchId !== undefined) void invoke('unwatch_folder', { id: watchId });
			};
		});
	}

	/** The current classified folder. Reading it activates the watch. */
	get read(): FolderRead {
		this.#subscribe();
		const rows = [...this.#rows.values()];
		return {
			rows,
			unreadable: [...this.#unreadable].map(([path, reason]) => ({ path, reason })),
			view: buildView(rows, this.#modelText),
		};
	}

	/** Whether the first batch has landed. Reading it activates the watch. */
	get status(): 'loading' | 'ready' {
		this.#subscribe();
		return this.#status;
	}

	/** Set if the watch could not be established. Reading it activates the watch. */
	get error(): string | undefined {
		this.#subscribe();
		return this.#error;
	}

	/** Apply one pushed batch to the in-memory maps (the seed and every update). */
	#applyDeltas(deltas: FileDelta[]) {
		for (const delta of deltas) {
			if (delta.name === 'matter.json') {
				// A removed or unreadable model is no model: degrade to the raw view.
				this.#modelText = delta.kind === 'content' ? delta.text : undefined;
				continue;
			}
			switch (delta.kind) {
				case 'content':
					this.#ingest(delta.name, delta.text);
					break;
				case 'removed':
					this.#rows.delete(delta.name);
					this.#unreadable.delete(delta.name);
					break;
				case 'unreadable':
					this.#rows.delete(delta.name);
					this.#unreadable.set(delta.name, 'unreadable');
					break;
			}
		}
	}

	/** Parse one file into the readable rows or the unreadable list. */
	#ingest(name: string, content: string) {
		const parsed = parseMarkdown(content);
		if (parsed.ok) {
			this.#rows.set(name, {
				path: name,
				frontmatter: parsed.frontmatter,
				body: parsed.body,
			});
			this.#unreadable.delete(name);
		} else {
			this.#unreadable.set(name, parsed.reason);
			this.#rows.delete(name);
		}
	}
}

/** Prompt for a folder and open it as a live {@link Vault}. `null` if cancelled. */
export async function openVault(): Promise<Vault | null> {
	const path = await open({
		directory: true,
		multiple: false,
		title: 'Open vault folder',
	});
	if (path === null || Array.isArray(path)) return null;
	return new Vault(path);
}
