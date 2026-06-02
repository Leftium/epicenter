import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import { assembleMarkdown } from '../../../markdown/assemble-markdown.js';
import type { BaseRow } from '../../table.js';
import type { AnyTable } from '../shared.js';

// ════════════════════════════════════════════════════════════════════════════
// Shared substrate for the two markdown seams (vault + export)
//
// Both seams continuously materialize Yjs -> disk: an observe-driven write of
// every valid row to a `.md` file, plus a destructive `rebuild`. They differ
// only in HOW a row renders to a file (the vault is rigid: `<id>.md`, frontmatter
// is the row; the export is free: custom filename + serialization). That single
// difference is injected as a `RenderRow`; everything else lives here.
// ════════════════════════════════════════════════════════════════════════════

/** Frontmatter + optional body, the parsed/assembled shape of a `.md` file. */
export type MarkdownShape = {
	frontmatter: Record<string, unknown>;
	body: string | undefined;
};

/** Render a row to its on-disk artifact: the one thing the two seams disagree on. */
export type RenderRow = (
	row: BaseRow,
) => Promise<{ filename: string; content: string }>;

/**
 * What materialize last wrote for a row, keyed by id. Drives rename cleanup (the
 * filename changed) and, later, dirty detection (the on-disk content diverged
 * from what we wrote, so a local edit is pending and must not be stomped).
 */
export type FileState = Map<string, { filename: string; content: string }>;

/**
 * Errors produced by the background write-observer (table row → .md file).
 * These run inside `.catch(...)` of a detached async task, so they ship to the
 * logger, not through a Result to the caller.
 */
export const MaterializerWriteError = defineErrors({
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

/**
 * Best-effort unlink. Returns `true` when the file actually went away (so the
 * caller can mark it dirty for git); `false` when it was already missing or the
 * remove failed.
 */
export async function tryUnlink(
	directory: string,
	filename: string,
): Promise<boolean> {
	try {
		await unlink(join(directory, filename));
		return true;
	} catch {
		return false;
	}
}

/** Read a file's content, or `undefined` if it does not exist (or cannot be read). */
async function readContentOrUndefined(
	directory: string,
	filename: string,
): Promise<string | undefined> {
	try {
		return await readFile(join(directory, filename), 'utf-8');
	} catch {
		return undefined;
	}
}

/**
 * Write a markdown file under `directory`, creating any intermediate
 * subdirectories implied by a filename like `"archive/old.md"`.
 */
export async function writeMarkdownFile(
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

/** Assemble frontmatter + body into the on-disk string. Re-exported for seams. */
export { assembleMarkdown };

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
	/**
	 * Don't overwrite a file whose on-disk content has diverged from what we last
	 * wrote: a local edit (or a deletion) is pending and apply has not reconciled
	 * it yet. The editable vault sets this so continuous materialize never stomps
	 * an in-progress edit; the read-only export leaves it off so the projection
	 * always reflects Yjs. The base is in-memory per session, so a daemon restart
	 * re-materializes (restart-as-heal); run apply before restarting if edits are
	 * pending.
	 */
	protectLocalEdits?: boolean;
}): Promise<() => void> {
	const { table, directory, render, fileState, log } = opts;
	const protectLocalEdits = opts.protectLocalEdits ?? false;

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
		// Dirty guard (vault only): if a file we previously wrote now differs on
		// disk from BOTH our last write AND the content we're about to write, a
		// pending local edit (or deletion) exists that apply has not folded into
		// the row. Leave it untouched. The `onDisk === content` case (the file
		// already matches the new render, e.g. apply just reconciled this edit)
		// falls through, re-baselining `fileState` so future updates resume.
		if (protectLocalEdits && previous) {
			const onDisk = await readContentOrUndefined(directory, previous.filename);
			if (onDisk !== previous.content && onDisk !== content) return;
		}
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
				MaterializerWriteError.TableWriteFailed({ tableName: table.name, cause }),
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

