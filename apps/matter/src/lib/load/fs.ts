/**
 * The Node filesystem boundary: turn a directory on disk into the in-memory {@link TableInput}s
 * that `assess` classifies. The pure transforms (`readFolder`, `assess`) never touch disk; this is
 * the one place that does, so the whole pipeline is testable without a filesystem and the listing
 * is not duplicated per surface.
 *
 * This is the single home for the disk listing that the CLI (`src/cli/check.ts`) and the headless
 * reference script (`scripts/check-references.ts`) each wrote their own copy of: list a folder's
 * `.md` files, read each (a read failure becomes an unreadable entry, never a dropped file), and
 * read its optional `matter.json`. {@link loadTable} is the single-folder case; {@link loadVault}
 * is the vault case, where every immediate subfolder is a table.
 *
 * It emits {@link TableInput}, not the bare `LoadedTable` of `core/references`, because a
 * filesystem is exactly where "could not read this folder" originates, and `TableInput`'s
 * `unreadable` variant is the one input that carries that fact into `assess`. A folder whose
 * listing fails (missing, permission) becomes that variant; a folder with no `matter.json` is NOT
 * a failure, it loads as a valid untyped table (the raw grid).
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { type FolderEntry, MatterReadError, readFolder } from '../core/folder';
import type { TableInput } from '../core/integrity';

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The folder's `.md` files as {@link FolderEntry}s, sorted by name for deterministic output. A
 * per-file read failure becomes an entry carrying its {@link MatterReadError}, so an unreadable
 * file surfaces as such instead of vanishing from the listing.
 */
async function readEntries(dir: string): Promise<FolderEntry[]> {
	const fileNames = (await readdir(dir))
		.filter((f) => f.endsWith('.md'))
		.sort();
	return Promise.all(
		fileNames.map(async (fileName): Promise<FolderEntry> => {
			try {
				return {
					fileName,
					content: await readFile(join(dir, fileName), 'utf8'),
				};
			} catch (cause) {
				return { fileName, error: MatterReadError.ReadFailed({ cause }).error };
			}
		}),
	);
}

/**
 * The folder's `matter.json` text, or `undefined` when it has none. A missing OR unreadable
 * `matter.json` both collapse to `undefined` (a valid untyped table); only a PRESENT-but-corrupt
 * model is a failure, and that is `readFolder`'s job to detect from the text it parses, not this
 * boundary's. Matches the reference script's loader.
 */
async function readModelText(dir: string): Promise<string | undefined> {
	return readFile(join(dir, 'matter.json'), 'utf8').catch(() => undefined);
}

/**
 * Load one folder into a {@link TableInput}. The table name is the folder's basename. A folder
 * whose listing fails (missing, permission) becomes the `unreadable` input, which contributes no
 * rows and turns every inbound reference into `missing-target`; otherwise it loads its rows and
 * optional contract into the `readable` input.
 *
 * @param dir the table folder's path.
 */
export async function loadTable(dir: string): Promise<TableInput> {
	const dirPath = resolve(dir);
	const name = basename(dirPath);

	let entries: FolderEntry[];
	try {
		entries = await readEntries(dirPath);
	} catch (error) {
		return { name, status: 'unreadable', message: messageOf(error) };
	}

	const read = readFolder(entries, await readModelText(dirPath));
	return { name, status: 'readable', read };
}

/**
 * Load a vault root: every immediate subfolder is a table, loaded in sorted order. Loose files at
 * the root (a stray `README.md`) are ignored; only directories are tables. An empty root (no
 * subfolders yet) loads as an empty vault, not an error.
 *
 * @param root the vault root's path.
 */
export async function loadVault(root: string): Promise<TableInput[]> {
	const rootPath = resolve(root);
	const names = await readdir(rootPath);
	const subdirs = await Promise.all(
		names.map(async (name) =>
			(await stat(join(rootPath, name))).isDirectory() ? name : null,
		),
	);
	return Promise.all(
		subdirs
			.filter((name): name is string => name !== null)
			.sort()
			.map((name) => loadTable(join(rootPath, name))),
	);
}
