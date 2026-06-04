/**
 * Read a folder of markdown into the model, then classify it.
 *
 * This is the pure transform: given each file's path and raw content (and an
 * optional `matter.json` text), it produces the readable rows, the unreadable
 * files (kept separate, never dropped), and EITHER a modeled classification (a
 * valid `matter.json` was supplied) OR an inferred preview (no model, or junk
 * model). The actual disk/Tauri listing lives behind the `#platform/fs` seam and
 * hands its results here, so the transform is testable without any filesystem.
 *
 * Inference is the on-ramp, never the foundation: a usable `matter.json` always
 * wins, and a junk one degrades to the preview with a diagnostic the UI can show
 * as a non-blocking banner.
 */

import {
	classifyRows,
	type CompiledColumn,
	type RowConformance,
} from './conformance';
import { inferColumns, type InferredColumn } from './infer';
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
 * No usable model: an inferred PREVIEW. `modelError` is set when a `matter.json`
 * existed but was junk (so the UI can say "couldn't read your model"), and unset
 * when there simply is no model.
 */
export type InferredView = {
	mode: 'inferred';
	columns: InferredColumn[];
	modelError?: string;
};

export type FolderRead = {
	rows: Row[];
	unreadable: UnreadableFile[];
	view: ModeledView | InferredView;
};

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
): ModeledView | InferredView {
	if (modelText === undefined) {
		return { mode: 'inferred', columns: inferColumns(rows) };
	}

	const parsed = parseModel(modelText);
	if (!parsed.ok) {
		// Junk model: degrade to the preview, but carry the diagnostic so the UI can
		// surface it. Deleting matter.json always recovers a working preview.
		return { mode: 'inferred', columns: inferColumns(rows), modelError: parsed.reason };
	}

	const { columns, conformance } = classifyRows(parsed.model, rows);
	return { mode: 'modeled', model: parsed.model, columns, conformance };
}
