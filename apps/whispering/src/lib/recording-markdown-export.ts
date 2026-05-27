import type { Table } from '@epicenter/workspace';
import yaml from 'js-yaml';
import { createLogger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import { report } from './report';
import { commands } from './tauri/commands';
import type { Recording } from './workspace';

const log = createLogger('whispering/recording-markdown-export');
const REALTIME_CHUNK_SIZE = 100;
const REBUILD_CHUNK_SIZE = 250;

export type RecordingMarkdownRebuildResult = {
	deleted: number;
	written: number;
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
		dir: string | Promise<string>;
		waitFor: Promise<unknown>;
	},
) {
	// Serialized promise chain: observer batches complete sequentially so
	// rapid changes don't produce overlapping Rust invoke calls.
	let syncQueue = Promise.resolve();
	let isDisposed = false;
	let scheduled = false;
	let hasShownFailureToast = false;
	const pendingIds = new Set<string>();
	const dirPromise = Promise.resolve(config.dir);

	function recordFailure(error: unknown) {
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
		chunkSize = REALTIME_CHUNK_SIZE,
	) {
		if (files.length === 0) return 0;

		const dir = await dirPromise;
		let written = 0;
		for (const chunk of chunks(files, chunkSize)) {
			if (isDisposed) return written;
			const { error } = await commands.writeMarkdownFiles(dir, chunk);
			if (error !== null) throw error;
			written += chunk.length;
		}
		return written;
	}

	async function deleteFiles(filenames: string[]) {
		if (filenames.length === 0) return;

		const dir = await dirPromise;
		for (const chunk of chunks(filenames, REALTIME_CHUNK_SIZE)) {
			if (isDisposed) return;
			const { error } = await commands.deleteFilesInDirectory(dir, {
				kind: 'filenames',
				filenames: chunk,
			});
			if (error !== null) throw error;
		}
	}

	async function writeAllRecordings() {
		if (isDisposed) return 0;

		const files = recordings.getAllValid().map(toRecordingMarkdownFile);
		return writeFiles(files);
	}

	async function rebuildAllRecordings(): Promise<RecordingMarkdownRebuildResult> {
		if (isDisposed) return { deleted: 0, written: 0 };

		const dir = await dirPromise;
		const { data: deleted, error } = await commands.deleteFilesInDirectory(
			dir,
			{
				kind: 'extension',
				extension: 'md',
			},
		);
		if (error !== null) throw error;

		const files = recordings.getAllValid().map(toRecordingMarkdownFile);
		const written = await writeFiles(files, REBUILD_CHUNK_SIZE);
		return { deleted, written };
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

	function dispose() {
		if (isDisposed) return;
		isDisposed = true;
		unsubscribe();
	}

	const whenExported = (async () => {
		await config.waitFor;
		syncQueue = syncQueue
			.then(async () => {
				await writeAllRecordings();
			})
			.catch(recordFailure);
		await syncQueue;
	})();

	ydoc.once('destroy', dispose);

	return {
		/** Resolves after the initial markdown export attempt completes. */
		whenExported,
		/** Re-export every current recording row to markdown. */
		async rebuild(): Promise<RecordingMarkdownRebuildResult> {
			hasShownFailureToast = false;
			let result: RecordingMarkdownRebuildResult | undefined;
			let failure: unknown;
			syncQueue = syncQueue
				.then(async () => {
					result = await rebuildAllRecordings();
				})
				.catch((error) => {
					failure = error;
					recordFailure(error);
				});
			await syncQueue;
			if (failure !== undefined) throw failure;
			return result ?? { deleted: 0, written: 0 };
		},
		/** Stop observing recording changes and skip future writes. */
		[Symbol.dispose]: dispose,
	};
}
