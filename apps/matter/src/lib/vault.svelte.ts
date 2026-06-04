/**
 * A live view over a folder on disk.
 *
 * The folder is the truth and other processes write it (agents, your editor, git),
 * so the vault is not a one-shot read: it seeds from `read_folder`, then keeps a
 * `SvelteMap` of rows in sync via a native folder watcher (`watch_folder`, backed
 * by `notify`). `createSubscriber` runs the watch only while something observes
 * `read`, and tears it down otherwise. Each change re-reads ONLY the file that
 * changed (`read_file`); classification (`buildView`) is recomputed from the
 * current rows, and the keyed grid re-renders just the rows that actually moved.
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

/** Shape returned by the Rust `read_folder` command (serde camelCase). */
type FolderSnapshot = {
	name: string;
	entries: { name: string; content: string }[];
	modelText: string | null;
};

/** One debounced batch of changed absolute paths from `watch_folder`. */
type WatchPayload = { paths: string[] };

const basename = (path: string) => path.split(/[/\\]/).pop() ?? path;
const isMarkdown = (name: string) => name.endsWith('.md');

export class Vault {
	/** The folder's display name (its basename). */
	readonly name: string;
	/** The folder's absolute path. */
	readonly path: string;

	// Keyed by filename: a single file's change touches only its entry.
	#rows = new SvelteMap<string, Row>();
	#unreadable = new SvelteMap<string, UnreadableFile['reason']>();
	#modelText = $state<string | undefined>(undefined);
	#subscribe: () => void;

	constructor(path: string, snapshot: FolderSnapshot) {
		this.path = path;
		this.name = snapshot.name;
		this.#modelText = snapshot.modelText ?? undefined;
		for (const entry of snapshot.entries) this.#ingest(entry.name, entry.content);

		// The watch is live only while `read` is observed (createSubscriber's
		// start/stop lifecycle), so closing the page stops the OS watcher.
		this.#subscribe = createSubscriber((update) => {
			const channel = new Channel<WatchPayload>();
			let watchId: number | undefined;
			channel.onmessage = (payload) => {
				void this.#applyChanges(payload.paths).then(update);
			};
			void invoke<number>('watch_folder', { path, channel }).then((id) => {
				watchId = id;
			});
			return () => {
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

	/** Re-read each changed path and reconcile the in-memory maps. */
	async #applyChanges(paths: string[]) {
		await Promise.all(
			[...new Set(paths)].map(async (path) => {
				const name = basename(path);
				if (name === 'matter.json') {
					this.#modelText =
						(await invoke<string | null>('read_file', { path })) ?? undefined;
					return;
				}
				if (!isMarkdown(name)) return;
				const content = await invoke<string | null>('read_file', { path });
				if (content === null) {
					this.#rows.delete(name);
					this.#unreadable.delete(name);
				} else {
					this.#ingest(name, content);
				}
			}),
		);
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
	const snapshot = await invoke<FolderSnapshot>('read_folder', { path });
	return new Vault(path, snapshot);
}
