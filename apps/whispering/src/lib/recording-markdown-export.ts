import type { Table } from '@epicenter/workspace';
import yaml from 'js-yaml';
import { writable, type Readable } from 'svelte/store';
import { createLogger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import { report } from './report';
import { commands } from './tauri/commands';
import type { Recording } from './workspace';

const log = createLogger('whispering/recording-markdown-export');
const REALTIME_CHUNK_SIZE = 100;

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

function chunks<T>(items: T[], size: number) {
	const result: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		result.push(items.slice(i, i + size));
	}
	return result;
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
	let scheduled = false;
	let hasShownFailureToast = false;
	const pendingIds = new Set<string>();
	const lastErrorWritable = writable<{ at: Date; error: unknown } | null>(null);
	const lastError: Readable<{ at: Date; error: unknown } | null> =
		lastErrorWritable;

	function recordFailure(error: unknown) {
		lastErrorWritable.set({ at: new Date(), error });
		log.error(
			error instanceof Error
				? error
				: new Error('Recording markdown export failed', { cause: error }),
		);

		if (hasShownFailureToast) return;
		hasShownFailureToast = true;
		report.error({
			title: 'Recording markdown export failed',
			cause: {
				name: 'RecordingMarkdownExportFailed',
				message:
					error instanceof Error
						? error.message
						: 'Could not write markdown files',
			},
		});
	}

	async function writeFiles(
		files: ReturnType<typeof toRecordingMarkdownFile>[],
	) {
		for (const chunk of chunks(files, REALTIME_CHUNK_SIZE)) {
			if (isDisposed) return;
			const { error } = await commands.writeRecordingMarkdownFiles(chunk);
			if (error !== null) throw error;
		}
	}

	async function deleteFiles(filenames: string[]) {
		for (const chunk of chunks(filenames, REALTIME_CHUNK_SIZE)) {
			if (isDisposed) return;
			const { error } = await commands.deleteRecordingFiles(chunk);
			if (error !== null) throw error;
		}
	}

	async function writeAllRecordings() {
		if (isDisposed) return;

		const files = recordings.getAllValid().map(toRecordingMarkdownFile);
		await writeFiles(files);
	}

	async function flushIds(ids: string[]) {
		if (isDisposed) return;

		const toWrite: ReturnType<typeof toRecordingMarkdownFile>[] = [];
		const toDelete: string[] = [];

		for (const id of ids) {
			const { data: row, error } = recordings.get(id);
			if (error) continue;
			if (row === null) {
				toDelete.push(`${id}.md`);
			} else {
				toWrite.push(toRecordingMarkdownFile(row));
			}
		}

		await writeFiles(toWrite);
		await deleteFiles(toDelete);
	}

	function schedule(ids: Iterable<string>) {
		for (const id of ids) pendingIds.add(id);
		if (scheduled) return;

		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			const ids = [...pendingIds];
			pendingIds.clear();
			syncQueue = syncQueue.then(() => flushIds(ids)).catch(recordFailure);
		});
	}

	const unsubscribe = recordings.observe((changedIds) => {
		if (isDisposed) return;
		schedule(changedIds);
	});

	const whenExported = (async () => {
		await config.waitFor;
		syncQueue = syncQueue.then(writeAllRecordings).catch(recordFailure);
		await syncQueue;
	})();

	ydoc.once('destroy', () => {
		unsubscribe();
	});

	return {
		/** Resolves after the initial markdown export attempt completes. */
		whenExported,
		/** Latest background export failure, or null after a successful reset path. */
		lastError,
		/** Re-export every current recording row to markdown. */
		async rebuild() {
			lastErrorWritable.set(null);
			hasShownFailureToast = false;
			syncQueue = syncQueue.then(writeAllRecordings).catch(recordFailure);
			await syncQueue;
		},
		/** Stop observing recording changes and skip future writes. */
		[Symbol.dispose]() {
			isDisposed = true;
			unsubscribe();
		},
	};
}

export type RecordingMarkdownExport = ReturnType<
	typeof attachRecordingMarkdownExport
>;
