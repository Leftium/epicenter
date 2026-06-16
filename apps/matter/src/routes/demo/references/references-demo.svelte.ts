/**
 * Reactive state for the `/demo/references` route.
 *
 * Loads the inlined three-table vault through the REAL `readFolder` pipeline and runs the
 * REAL `checkReferences` validator, so the Notion-like view renders the same resolution the
 * headless `scripts/check-references.ts` prints — no mock, just the pipeline minus IO.
 *
 * The one interactive knob is `includePages`: drop the `pages` folder and every
 * `adaptations.page` reference flips from resolved/dangling to MISSING_TARGET, which is how
 * you SEE the validator's distinction between "the target table is gone" and "the target row
 * is gone." It mirrors checking one folder of a vault in isolation.
 */

import {
	checkReferences,
	type LoadedFolder,
	type ReferenceReport,
	referenceTargetOf,
} from '$lib/check/references';
import { type FolderRead, readFolder } from '$lib/core/folder';
import type { Row } from '$lib/core/parse';
import { REFERENCE_FIXTURES } from './references-fixtures';

/** The resolution verdict for one reference cell, carrying what the UI needs to render it. */
export type ReferenceCell =
	| { kind: 'resolved'; target: string; value: string; title: string; targetFile: string }
	| { kind: 'dangling'; target: string; value: string }
	| { kind: 'missing-target'; target: string; value: string }
	| { kind: 'empty'; target: string };

/** One loaded table plus its name, ready to render. */
export type ReferenceTable = { table: string; read: FolderRead };

/** A row's stem: its basename without `.md`, the form a reference value takes. */
function stemOf(fileName: string): string {
	return fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
}

export function createReferencesDemo() {
	// Drop `pages` to demonstrate MISSING_TARGET live; on by default so the happy path shows.
	let includePages = $state(true);

	const folders = $derived.by((): LoadedFolder[] =>
		REFERENCE_FIXTURES.filter(
			(fixture) => includePages || fixture.table !== 'pages',
		).map((fixture) => ({
			table: fixture.table,
			read: readFolder(fixture.rows, fixture.modelText),
		})),
	);

	// The authoritative validator output: the same report the CLI script prints.
	const report = $derived(checkReferences(folders));

	// stem -> Row per table, so a resolved chip can preview the target row's title.
	const rowsByTable = $derived.by(() => {
		const map = new Map<string, Map<string, Row>>();
		for (const folder of folders) {
			const byStem = new Map<string, Row>();
			for (const row of folder.read.rows) byStem.set(stemOf(row.fileName), row);
			map.set(folder.table, byStem);
		}
		return map;
	});

	// The report's findings, indexed for O(1) per-cell lookup while rendering.
	const danglingKeys = $derived(
		new Set(
			report.findings
				.filter((f) => f.kind === 'UNRESOLVED')
				.map((f) => `${f.table}|${f.file}|${f.field}`),
		),
	);
	const missingTargetKeys = $derived(
		new Set(
			report.findings
				.filter((f) => f.kind === 'MISSING_TARGET')
				.map((f) => `${f.table}|${f.field}`),
		),
	);

	/** Classify one reference cell for rendering, deferring to the report for the verdict. */
	function cellFor(table: string, fileName: string, fieldName: string, target: string): ReferenceCell {
		if (missingTargetKeys.has(`${table}|${fieldName}`)) {
			// Whole column unresolvable; show the value but flag the target as gone.
			const raw = rowsByTable.get(table)?.get(stemOf(fileName))?.frontmatter[fieldName];
			return { kind: 'missing-target', target, value: typeof raw === 'string' ? raw : '' };
		}
		if (danglingKeys.has(`${table}|${fileName}|${fieldName}`)) {
			const raw = rowsByTable.get(table)?.get(stemOf(fileName))?.frontmatter[fieldName];
			return { kind: 'dangling', target, value: typeof raw === 'string' ? raw : '' };
		}
		const value = rowsByTable.get(table)?.get(stemOf(fileName))?.frontmatter[fieldName];
		if (typeof value !== 'string' || value.length === 0) return { kind: 'empty', target };
		const targetRow = rowsByTable.get(target)?.get(value);
		const title = typeof targetRow?.frontmatter.title === 'string' ? targetRow.frontmatter.title : value;
		return { kind: 'resolved', target, value, title, targetFile: targetRow?.fileName ?? '' };
	}

	// Flat list of every present reference cell with its verdict, for the summary counts.
	const cells = $derived.by((): ReferenceCell[] => {
		const out: ReferenceCell[] = [];
		for (const { table, read } of folders) {
			if (read.view.mode !== 'modeled') continue;
			for (const field of read.view.model.fields) {
				const target = referenceTargetOf(field);
				if (target === null) continue;
				for (const conformance of read.view.conformance) {
					const cell = conformance.cells.find((c) => c.field.name === field.name);
					if (cell?.state !== 'OK') continue; // only present, valid strings are references to resolve
					out.push(cellFor(table, conformance.row.fileName, field.name, target));
				}
			}
		}
		return out;
	});

	const counts = $derived({
		total: cells.length,
		resolved: cells.filter((c) => c.kind === 'resolved').length,
		dangling: cells.filter((c) => c.kind === 'dangling').length,
		missingTarget: cells.filter((c) => c.kind === 'missing-target').length,
	});

	return {
		get folders(): ReferenceTable[] {
			return folders;
		},
		get report(): ReferenceReport {
			return report;
		},
		get counts() {
			return counts;
		},
		get includePages(): boolean {
			return includePages;
		},
		set includePages(value: boolean) {
			includePages = value;
		},
		/** The resolution verdict for one reference cell, for the database view to render. */
		cellFor,
	};
}
