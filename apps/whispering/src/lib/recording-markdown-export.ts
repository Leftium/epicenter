import type { Table } from '@epicenter/workspace';
import yaml from 'js-yaml';
import { createLogger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import { commands } from './tauri/commands';
import type { Recording } from './workspace';

const log = createLogger('whispering/recording-markdown-export');

export type RecordingMarkdownExport = {
	whenExported: Promise<void>;
	rebuild(): Promise<void>;
	[Symbol.dispose](): void;
};

/**
 * Serialize a recording row to a markdown file.
 *
 * Puts `transcript` in the body and all other metadata in YAML frontmatter.
 */
function toRecordingMarkdownFile(row: Recording) {
	const { transcript, ...frontmatter } = row;
	const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 });
	return {
		filename: `${row.id}.md`,
		content: `---\n${yamlStr}---\n${transcript || ''}\n`,
	};
}

export function attachRecordingMarkdownExport(
	ydoc: Y.Doc,
	recordings: Table<Recording>,
	config: {
		waitFor: Promise<unknown>;
	},
) {
	let syncQueue = Promise.resolve();
	let isDisposed = false;

	async function writeAllRecordings() {
		if (isDisposed) return;

		const files = recordings.getAllValid().map(toRecordingMarkdownFile);
		if (files.length) {
			const { error } = await commands.writeRecordingMarkdownFiles(files);
			if (error !== null) throw error;
		}
	}

	const unsubscribe = recordings.observe((changedIds) => {
		if (isDisposed) return;

		syncQueue = syncQueue
			.then(async () => {
				if (isDisposed) return;

				const toWrite: { filename: string; content: string }[] = [];
				const toDelete: string[] = [];

				for (const id of changedIds) {
					const { data: row, error } = recordings.get(id);
					if (error) continue;
					if (row === null) {
						toDelete.push(`${id}.md`);
					} else {
						toWrite.push(toRecordingMarkdownFile(row));
					}
				}

				if (toWrite.length) {
					const { error } =
						await commands.writeRecordingMarkdownFiles(toWrite);
					if (error !== null) throw error;
				}
				if (toDelete.length) {
					const { error } = await commands.deleteRecordingFiles(toDelete);
					if (error !== null) throw error;
				}
			})
			.catch((error) => {
				log.error(
					error instanceof Error
						? error
						: new Error('Recording markdown export failed', { cause: error }),
				);
			});
	});

	const whenExported = (async () => {
		await config.waitFor;
		syncQueue = syncQueue.then(writeAllRecordings);
		await syncQueue;
	})();

	ydoc.once('destroy', () => {
		unsubscribe();
	});

	return {
		whenExported,
		async rebuild() {
			syncQueue = syncQueue.then(writeAllRecordings);
			await syncQueue;
		},
		[Symbol.dispose]() {
			isDisposed = true;
			unsubscribe();
		},
	} satisfies RecordingMarkdownExport;
}
