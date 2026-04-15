/**
 * Whispering workspace client—single Y.Doc with IndexedDB persistence.
 *
 * On desktop (Tauri), a workspace extension observes the recordings table and
 * invokes Rust commands to write `{id}.md` files to the recordings directory.
 * JS handles serialization; Rust handles atomic filesystem writes.
 */

import { createWorkspace } from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import { PATHS } from '$lib/constants/paths';
import yaml from 'js-yaml';
import type { Recording } from './workspace';
import { whisperingDefinition } from './workspace/definition';

function serializeRecording(row: Recording) {
	const { transcript, _v, ...frontmatter } = row;
	const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 });
	const yamlBlock = yamlStr.endsWith('\n') ? yamlStr : `${yamlStr}\n`;
	return {
		filename: `${row.id}.md`,
		content: `---\n${yamlBlock}---\n${transcript || ''}\n`,
	};
}

const base = createWorkspace(whisperingDefinition).withExtension(
	'persistence',
	indexeddbPersistence,
);

export const workspace = window.__TAURI_INTERNALS__
	? base.withWorkspaceExtension('materializer', (ctx) => {
			const unsubscribers: (() => void)[] = [];

			return {
				whenReady: (async () => {
					await ctx.whenReady;
					const { invoke } = await import('@tauri-apps/api/core');
					const dir = await PATHS.DB.RECORDINGS();

					// Initial flush—write all recordings to disk
					const files = ctx.tables.recordings
						.getAllValid()
						.map(serializeRecording);
					if (files.length) {
						await invoke('write_markdown_files', { directory: dir, files });
					}

					// Incremental sync—observe changes and write/delete as needed
					const unsub = ctx.tables.recordings.observe((changedIds) => {
						void (async () => {
							const toWrite: { filename: string; content: string }[] = [];
							const toDelete: string[] = [];

							for (const id of changedIds) {
								const result = ctx.tables.recordings.get(id);
								if (result.status === 'valid') {
									toWrite.push(serializeRecording(result.row));
								} else if (result.status === 'not_found') {
									const mdPath = await PATHS.DB.RECORDING_MD(id);
									toDelete.push(mdPath);
								}
							}

							if (toWrite.length) {
								await invoke('write_markdown_files', {
									directory: dir,
									files: toWrite,
								});
							}
							if (toDelete.length) {
								await invoke('bulk_delete_files', { paths: toDelete });
							}
						})().catch((error) => {
							console.warn('[recording-materializer] write failed:', error);
						});
					});
					unsubscribers.push(unsub);
				})(),
				dispose() {
					for (const fn of unsubscribers) fn();
				},
			};
		})
	: base;
