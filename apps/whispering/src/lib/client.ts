/**
 * Whispering workspace client—single Y.Doc with IndexedDB persistence.
 *
 * On desktop (Tauri), a workspace extension observes the recordings table and
 * invokes Rust commands to write `{id}.md` files to the recordings directory.
 * JS handles serialization; Rust handles atomic filesystem writes.
 */

import { createWorkspace } from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import yaml from 'js-yaml';

import { PATHS } from '$lib/constants/paths';
import type { Recording } from './workspace';
import { whisperingDefinition } from './workspace/definition';

function toRecordingMarkdownFile(row: Recording) {
	const { transcript, _v, ...frontmatter } = row;
	const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 });
	return {
		filename: `${row.id}.md`,
		content: `---\n${yamlStr}---\n${transcript || ''}\n`,
	};
		}

const base = createWorkspace(whisperingDefinition).withExtension(
	'persistence',
	indexeddbPersistence,
	);

export const workspace = window.__TAURI_INTERNALS__
	? base.withWorkspaceExtension('materializer', (ctx) => {
			let unsub: (() => void) | undefined;
			let syncQueue = Promise.resolve();

			return {
				whenReady: (async () => {
					await ctx.whenReady;
					const { invoke } = await import('@tauri-apps/api/core');
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

					// Initial flush—write all recordings to disk
					const files = ctx.tables.recordings
						.getAllValid()
						.map(toRecordingMarkdownFile);
					if (files.length) {
						await invoke('write_markdown_files', { directory: dir, files });
					}
				})(),
				async dispose() {
					unsub?.();
					await syncQueue;
				},
			};
		})
	: base;
