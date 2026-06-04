/**
 * Read a folder of markdown into the model, then classify it.
 *
 * This is the pure transform: given each file's path and raw content (and an
 * optional `matter.json` text), it produces the readable rows, the unreadable
 * files (kept separate, never dropped), and EITHER a modeled classification (a
 * valid `matter.json` was supplied) OR a raw untyped view (no model, or junk
 * model). The actual disk/Tauri listing lives behind the `#platform/fs` seam and
 * hands its results here, so the transform is testable without any filesystem.
 *
 * The model is the foundation, never inference: a usable `matter.json` classifies
 * the folder against a contract; without one, the folder is shown as RAW text
 * (no type guessing). A junk model degrades to the raw view with a diagnostic the
 * UI can show as a non-blocking banner. Turning a raw folder into a model
 * ("Create model from folder") is a deferred, schema-emitting step.
 */

import {
	classifyRows,
	type CompiledColumn,
	type RowConformance,
} from './conformance';
import { type MatterModel, parseModel } from './model';
import { type ParsedFile, parseMarkdown } from './parse';
import type { Row } from './types';

export type FolderEntry = { path: string; content: string };

export type UnreadableFile = {
	path: string;
	reason: Extract<ParsedFile, { ok: false }>['reason'];
};

/**
 * The folder is classified against an explicit model: rows split into valid /
 * needs-attention by per-cell conformance.
 */
export type ModeledView = {
	mode: 'modeled';
	model: MatterModel;
	columns: CompiledColumn[];
	conformance: RowConformance[];
};

/**
 * No usable model: the folder is shown as a RAW untyped grid (every value as
 * plain text, no type inference). `columns` is the deterministic union of
 * frontmatter keys. `modelError` is set when a `matter.json` existed but was junk
 * (so the UI can say "couldn't read your model"), and unset when there simply is
 * no model.
 */
export type UnmodeledView = {
	mode: 'unmodeled';
	columns: string[];
	modelError?: string;
};

export type FolderRead = {
	rows: Row[];
	unreadable: UnreadableFile[];
	view: ModeledView | UnmodeledView;
};

/**
 * The ordered column keys of an unmodeled folder: the union of every row's
 * frontmatter keys, most-frequent first then first-seen, so the raw grid is
 * deterministic across opens. No type inference: a folder without a model is
 * shown as raw text, never guessed into kinds.
 */
export function frontmatterColumns(rows: readonly Row[]): string[] {
	const count = new Map<string, number>();
	const firstSeen: string[] = [];
	for (const row of rows) {
		for (const key of Object.keys(row.frontmatter)) {
			if (!count.has(key)) firstSeen.push(key);
			count.set(key, (count.get(key) ?? 0) + 1);
		}
	}
	return firstSeen
		.map((key, index) => ({ key, index, count: count.get(key) ?? 0 }))
		.sort((a, b) => b.count - a.count || a.index - b.index)
		.map((c) => c.key);
}

/**
 * Read and classify a folder.
 *
 * @param entries the folder's `.md` files (path + raw content).
 * @param modelText the raw text of the folder's `matter.json`, if present.
 */
export function readFolder(
	entries: readonly FolderEntry[],
	modelText?: string,
): FolderRead {
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

	return { rows, unreadable, view: buildView(rows, modelText) };
}

function buildView(
	rows: readonly Row[],
	modelText: string | undefined,
): ModeledView | UnmodeledView {
	if (modelText === undefined) {
		return { mode: 'unmodeled', columns: frontmatterColumns(rows) };
	}

	const parsed = parseModel(modelText);
	if (!parsed.ok) {
		// Junk model: degrade to the raw view, but carry the diagnostic so the UI can
		// surface it. Deleting matter.json always recovers a working raw view.
		return {
			mode: 'unmodeled',
			columns: frontmatterColumns(rows),
			modelError: parsed.reason,
		};
	}

	const { columns, conformance } = classifyRows(parsed.model, rows);
	return { mode: 'modeled', model: parsed.model, columns, conformance };
}
