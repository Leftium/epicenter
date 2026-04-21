/**
 * Recording materializer — desktop-only workspace extension that mirrors the
 * `recordings` table into `{id}.md` files on disk.
 *
 * The factory observes the recordings table and invokes Tauri Rust commands
 * (`write_markdown_files`, `delete_files_in_directory`) through a serialized
 * promise chain, so rapid changes never produce overlapping writes.
 *
 * Only import from Tauri runtimes — uses `@tauri-apps/api/core.invoke`, which
 * throws in the browser.
 */

import type { Table } from '@epicenter/workspace';
import { invoke } from '@tauri-apps/api/core';
import yaml from 'js-yaml';
import { PATHS } from '$lib/constants/paths';
import type { Recording } from './workspace';

/**
 * Serialize a recording row to a markdown file.
 *
 * Puts `transcript` in the body and all other metadata in YAML frontmatter.
 * Strips `_v` (workspace internal, not useful in human-readable files).
 */
function toRecordingMarkdownFile(row: Recording) {
	const { transcript, _v, ...frontmatter } = row;
	const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 });
	return {
		filename: `${row.id}.md`,
		content: `---\n${yamlStr}---\n${transcript || ''}\n`,
	};
}

export function createRecordingMaterializer(ctx: {
	tables: { recordings: Table<Recording> };
	init: Promise<void>;
}) {
	let unsub: (() => void) | undefined;
	// Serialized promise chain — ensures observer batches complete sequentially
	// so rapid changes don't produce overlapping Rust invoke calls.
	let syncQueue = Promise.resolve();

	return {
		exports: {},
		init: (async () => {
			await ctx.init;
			const dir = await PATHS.DB.RECORDINGS();

			// Subscribe BEFORE flush so changes during flush aren't missed
			unsub = ctx.tables.recordings.observe((changedIds) => {
				syncQueue = syncQueue
					.then(async () => {
						const toWrite: { filename: string; content: string }[] = [];
						const toDelete: string[] = [];

						for (const id of changedIds) {
							const result = ctx.tables.recordings.get(id);
							if (result.status === 'valid') {
								toWrite.push(toRecordingMarkdownFile(result.row));
							} else if (result.status === 'not_found') {
								toDelete.push(`${id}.md`);
							}
						}

						if (toWrite.length) {
							await invoke('write_markdown_files', {
								directory: dir,
								files: toWrite,
							});
						}
						if (toDelete.length) {
							await invoke('delete_files_in_directory', {
								directory: dir,
								filenames: toDelete,
							});
						}
					})
					.catch((error) => {
						console.warn('[recording-materializer] write failed:', error);
					});
			});

			// Initial flush — write all recordings to disk.
			// Routed through syncQueue so observer writes that fire during
			// flush don't overlap with it.
			syncQueue = syncQueue.then(async () => {
				const files = ctx.tables.recordings
					.getAllValid()
					.map(toRecordingMarkdownFile);
				if (files.length) {
					await invoke('write_markdown_files', { directory: dir, files });
				}
			});
			await syncQueue;
		})(),
		// Unsubscribe immediately, then wait for any in-flight write to finish
		async dispose() {
			unsub?.();
			await syncQueue;
		},
	};
}
