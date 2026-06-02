import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import type { BaseRow } from '../../table.js';
import type { AnyTable } from '../shared.js';

// ════════════════════════════════════════════════════════════════════════════
// Shared substrate for the markdown export seam
//
// Continuously materialize Yjs -> disk: an observe-driven write of every valid
// row to a `.md` file, plus a destructive `rebuild`. HOW a row renders to a file
// (custom filename + serialization) is injected as a `RenderRow`; the
// observe/flush/rebuild machinery lives here.
// ════════════════════════════════════════════════════════════════════════════

/** Frontmatter + optional body, the parsed/assembled shape of a `.md` file. */
export type MarkdownShape = {
	frontmatter: Record<string, unknown>;
	body: string | undefined;
};

/** Render a row to its on-disk artifact: the export's injected serialization. */
export type RenderRow = (
	row: BaseRow,
) => Promise<{ filename: string; content: string }>;

/**
 * What materialize last wrote for a row, keyed by id. Drives rename cleanup:
 * when a row's filename changes, unlink the previous file before writing the new
 * one so a rename does not leave an orphan behind.
 */
export type FileState = Map<string, { filename: string; content: string }>;

/**
 * Errors produced by the background write-observer (table row → .md file).
 * These run inside `.catch(...)` of a detached async task, so they ship to the
 * logger, not through a Result to the caller.
 */
const MaterializerWriteError = defineErrors({
	TableWriteFailed: ({
		tableName,
		id,
		cause,
	}: {
		tableName: string;
		id?: string;
		cause: unknown;
	}) => ({
		message: `[markdown] table write failed for "${tableName}"${id ? ` (row "${id}")` : ''}: ${extractErrorMessage(cause)}`,
		tableName,
		id,
		cause,
	}),
});

/** Best-effort unlink; a missing file or a failed remove is ignored. */
async function tryUnlink(directory: string, filename: string): Promise<void> {
	try {
		await unlink(join(directory, filename));
	} catch {
		// already gone, or the remove failed; nothing to do
	}
}

/**
 * Write a markdown file under `directory`, creating any intermediate
 * subdirectories implied by a filename like `"archive/old.md"`.
 */
async function writeMarkdownFile(
	directory: string,
	filename: string,
	content: string,
): Promise<void> {
	const fullPath = join(directory, filename);
	const parent = dirname(fullPath);
	if (parent !== directory) {
		await mkdir(parent, { recursive: true });
	}
	await writeFile(fullPath, content);
}

/**
 * Continuously materialize one table to `directory`: an initial flush of every
 * valid row, then an observe that rewrites a row's file on change and unlinks it
 * when the row goes invalid or is deleted. Returns the observer unsubscribe.
 *
 * Only CONTENT PRODUCTION is guarded: a throwing `render` (e.g. a body read
 * hitting its connect deadline) skips that one row and leaves its existing `.md`
 * intact, instead of aborting the rest of the flush or the observe batch. A real
 * filesystem write failure (ENOSPC, EACCES) is NOT swallowed: it propagates, so
 * the initial flush rejects and the observer's outer catch surfaces it.
 */
export async function materializeTable(opts: {
	table: AnyTable;
	directory: string;
	render: RenderRow;
	fileState: FileState;
	log: Logger;
}): Promise<() => void> {
	const { table, directory, render, fileState, log } = opts;

	await mkdir(directory, { recursive: true });

	// Write one valid row to disk, shared by the initial flush and the observer.
	// The rename branch is a no-op on first write (`fileState` starts empty), so
	// both paths run this exact code.
	async function writeRow(id: string, row: BaseRow): Promise<void> {
		let rendered: { filename: string; content: string };
		try {
			rendered = await render(row);
		} catch (cause) {
			log.warn(
				MaterializerWriteError.TableWriteFailed({
					tableName: table.name,
					id,
					cause,
				}),
			);
			return;
		}
		const { filename, content } = rendered;
		const previous = fileState.get(id);
		if (previous && previous.filename !== filename) {
			await tryUnlink(directory, previous.filename);
		}
		await writeMarkdownFile(directory, filename, content);
		fileState.set(id, { filename, content });
	}

	for (const row of table.getAllValid()) {
		await writeRow(row.id, row);
	}

	// Sequential writes inside the observer avoid rename races; a parallel
	// approach (Promise.allSettled) could delete a file another write needs.
	return table.observe((changedIds) => {
		void (async () => {
			for (const id of changedIds) {
				const { data: row, error } = table.get(id);

				// Invalid or missing → unlink any previously-written file.
				if (error || row === null) {
					const previous = fileState.get(id);
					if (previous) {
						await tryUnlink(directory, previous.filename);
						fileState.delete(id);
					}
					continue;
				}

				await writeRow(id, row);
			}
		})().catch((cause) => {
			// Reached only by a genuine failure `writeRow` does not swallow: a
			// filesystem write error, or an unexpected throw in the loop scaffolding.
			log.warn(
				MaterializerWriteError.TableWriteFailed({
					tableName: table.name,
					cause,
				}),
			);
		});
	});
}

/**
 * Destructive re-export of one table to `directory`: render every valid row
 * BEFORE touching disk (a throwing render aborts the rebuild with the existing
 * files intact, rather than deleting everything and then failing to rewrite),
 * then sweep existing `.md` files and write the rendered set. Updates `fileState`
 * so the live observer and dirty detection stay consistent.
 */
export async function rebuildTable(opts: {
	table: AnyTable;
	directory: string;
	render: RenderRow;
	fileState: FileState;
}): Promise<{ deleted: number; written: number }> {
	const { table, directory, render, fileState } = opts;
	let deleted = 0;
	let written = 0;

	const rendered: { id: string; filename: string; content: string }[] = [];
	for (const row of table.getAllValid()) {
		const r = await render(row);
		rendered.push({ id: row.id, filename: r.filename, content: r.content });
	}

	try {
		const files = await readdir(directory, { recursive: true });
		for (const filename of files) {
			if (!filename.endsWith('.md')) continue;
			const path = join(directory, filename);
			await unlink(path).then(
				() => {
					deleted++;
				},
				() => undefined,
			);
		}
	} catch {
		// Directory doesn't exist yet. Fine.
	}

	fileState.clear();
	await mkdir(directory, { recursive: true });
	for (const { id, filename, content } of rendered) {
		await writeMarkdownFile(directory, filename, content);
		fileState.set(id, { filename, content });
		written++;
	}

	return { deleted, written };
}
