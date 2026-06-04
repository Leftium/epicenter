/**
 * Read a folder of markdown into the model.
 *
 * This is the pure transform: given each file's path and raw content, it
 * produces the readable rows, the unreadable files (kept separate, never
 * dropped), and the inferred columns. The actual disk/Tauri listing lives
 * behind the `#platform/fs` seam and hands its results to this function, so the
 * transform is testable without any filesystem.
 */

import { inferColumns, type InferredColumn } from './infer';
import { type ParsedFile, parseMarkdown } from './parse';
import type { Row } from './types';

export type FolderEntry = { path: string; content: string };

export type UnreadableFile = {
	path: string;
	reason: Extract<ParsedFile, { ok: false }>['reason'];
};

export type FolderRead = {
	rows: Row[];
	unreadable: UnreadableFile[];
	columns: InferredColumn[];
};

export function readFolder(entries: readonly FolderEntry[]): FolderRead {
	const rows: Row[] = [];
	const unreadable: UnreadableFile[] = [];

	for (const { path, content } of entries) {
		const parsed = parseMarkdown(content);
		if (parsed.ok) {
			rows.push({ path, frontmatter: parsed.frontmatter, body: parsed.body });
		} else {
			unreadable.push({ path, reason: parsed.reason });
		}
	}

	return { rows, unreadable, columns: inferColumns(rows) };
}
