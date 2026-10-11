/** Pure file-browser mechanics over a folder listing and captured file bytes. */

import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileListing } from './boundary.js';
import type { TextCapture } from './capture.js';
import type { FileError } from './errors.js';
import type { FolderFiles } from './files.js';

export type TreeRow = {
	path: string;
	name: string;
	depth: number;
} & ({ kind: 'directory'; children: number } | { kind: 'file'; size: number });

export function basename(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

export function dirname(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

export function joinPath(directory: string, name: string): string {
	return directory === '' ? name : `${directory}/${name}`;
}

/** Every proper ancestor directory of a path, outermost first. */
export function ancestorsOf(path: string): string[] {
	const parts = path.split('/');
	return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

const byName = (a: string, b: string) =>
	a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }) ||
	(a < b ? -1 : a > b ? 1 : 0);

/**
 * The rows a tree shows: folders before files at each level, descending only
 * into expanded folders. Private Git state is never listed as source.
 */
export function visibleRows(
	listing: FileListing,
	expanded: ReadonlySet<string>,
): TreeRow[] {
	const directories = new Map<string, string[]>([['', []]]);
	const files = new Map<string, number>();
	const childrenOf = (directory: string) => {
		let list = directories.get(directory);
		if (list === undefined) {
			list = [];
			directories.set(directory, list);
		}
		return list;
	};
	const visible = (path: string) => path.split('/')[0] !== '.git';
	for (const directory of listing.directories) {
		if (!visible(directory)) continue;
		childrenOf(directory);
		childrenOf(dirname(directory)).push(directory);
	}
	for (const file of listing.files) {
		if (!visible(file.path)) continue;
		files.set(file.path, file.size);
		childrenOf(dirname(file.path)).push(file.path);
	}

	const rows: TreeRow[] = [];
	function walk(directory: string, depth: number) {
		const children = [...new Set(directories.get(directory))];
		const folders = children
			.filter((path) => directories.has(path))
			.sort((a, b) => byName(basename(a), basename(b)));
		const leaves = children
			.filter((path) => !directories.has(path))
			.sort((a, b) => byName(basename(a), basename(b)));
		for (const path of folders) {
			rows.push({
				kind: 'directory',
				path,
				name: basename(path),
				depth,
				children: new Set(directories.get(path)).size,
			});
			if (expanded.has(path)) walk(path, depth + 1);
		}
		for (const path of leaves)
			rows.push({
				kind: 'file',
				path,
				name: basename(path),
				depth,
				size: files.get(path) ?? 0,
			});
	}
	walk('', 0);
	return rows;
}

export type OpenedFile =
	| { kind: 'text'; file: TextCapture }
	| { kind: 'binary'; size: number }
	| { kind: 'tooLarge'; size: number };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Read a file for the editor. Only valid UTF-8 without NUL bytes opens as
 * text, and the decoded text keeps a byte order mark so a save writes the
 * same bytes back. The caller supplies its editing limit in bytes.
 */
export async function readTextFile(
	files: Pick<FolderFiles, 'read'>,
	path: string,
	maxBytes: number,
): Promise<Result<OpenedFile, FileError>> {
	const { data: file, error: readError } = await files.read(path);
	if (readError !== null) return Err(readError);
	const { bytes, sha256 } = file;
	if (bytes.byteLength > maxBytes)
		return Ok({ kind: 'tooLarge', size: bytes.byteLength });
	if (bytes.includes(0)) return Ok({ kind: 'binary', size: bytes.byteLength });
	try {
		return Ok({
			kind: 'text',
			file: { path, text: utf8.decode(bytes), sha256 },
		});
	} catch {
		return Ok({ kind: 'binary', size: bytes.byteLength });
	}
}

/** Textareas report LF; keep the file's CRLF line endings when it uses them. */
export function withFileNewlines(text: string, reference: string): string {
	return reference.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text;
}
