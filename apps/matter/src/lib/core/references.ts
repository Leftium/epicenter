/**
 * Row-level referential integrity across loaded folders.
 *
 * The construction-time floor (`assertReferenceTargets` in @epicenter/workspace) proves a
 * `field.reference(table)` column names a real TABLE. This is the next guarantee down: that
 * a stored reference VALUE names a real ROW. Answering it needs the live data of MORE than
 * one folder at once — the folder that holds the reference AND the folder it points at — so
 * it cannot live in the single-folder `check`, which sees only one folder's own model and
 * rows. It is a SECOND pass layered on conformance: a reference cell that is missing or
 * non-string is already classified by `classifyRow` (MISSING_REQUIRED / MISSING_OPTIONAL /
 * INVALID) under the folder's own policy, so this pass never second-guesses requiredness or
 * type. It asks the one question conformance cannot — does the present, valid string resolve
 * to a row that exists in the target folder.
 *
 * Generic over any reference field: the target table is read from the field's `x-ref` marker
 * ({@link REFERENCE_KEYWORD}), never hardcoded. A row's identity is its file STEM (the
 * basename without `.md`) — the form an author writes in frontmatter (`page:
 * become-the-source`) — so a target folder's existence set is the stems of its readable
 * rows. Existence is the FILE existing, not the row validating: a target row that has its
 * own conformance issues still satisfies a reference to it, and a target folder needs no
 * `matter.json` to be a valid namespace.
 *
 * Two findings, kept distinct because they have different causes and different fixes:
 *   MISSING_TARGET  the referenced table is not among the loaded folders. The whole column
 *                   is unresolvable, so it is reported ONCE per reference field, not once per
 *                   row (per-row findings would be noise on top of one structural cause).
 *   UNRESOLVED      the target folder IS loaded, but a row's reference value matches no stem
 *                   in it: a dangling pointer, reported per offending cell.
 */

import { referenceTargetOf } from '@epicenter/field';
import type { FolderRead } from './folder';
import { stemOf } from './parse';

/** A folder loaded for cross-folder reference checking, keyed by its table name. */
export type LoadedTable = {
	/** The folder's table name: the namespace a reference `x-ref` target resolves against. */
	name: string;
	/** The folder's read (rows + classified view), as produced by `readFolder`. */
	read: FolderRead;
};

/**
 * One referential-integrity problem. The two kinds (described in the module comment above) stay
 * one union because every caller handles them together — by `.kind`, never by a standalone type.
 */
export type ReferenceFinding =
	| {
			kind: 'MISSING_TARGET';
			/** The folder that declares the reference field. */
			table: string;
			/** The reference field's name. */
			field: string;
			/** The target table named by the field's `x-ref` marker, absent from the loaded set. */
			target: string;
	  }
	| {
			kind: 'UNRESOLVED';
			/** The folder that holds the dangling reference. */
			table: string;
			/** The row file whose reference value did not resolve. */
			file: string;
			/** The reference field's name. */
			field: string;
			/** The target table the value should have resolved within. */
			target: string;
			/** The unresolved value (the stem an author wrote). */
			value: string;
	  };

/**
 * Validate every reference VALUE against the rows of its target folder, returning one finding
 * per problem. Pure over a set of loaded folders (each paired with its table name), so it is
 * testable with in-memory reads and unaware of the filesystem, mirroring `readFolder` / `check`.
 */
export function resolveReferences(
	folders: readonly LoadedTable[],
): ReferenceFinding[] {
	// The existence set per table: the stems of every readable row. Built from EVERY loaded
	// folder so any can be a target, and from `read.rows` (not the conformance view) so an
	// unmodeled target folder still contributes its rows and a target row counts as existing
	// even when it has its own conformance issues.
	const stemsByTable = new Map<string, Set<string>>(
		folders.map((folder) => [
			folder.name,
			new Set(folder.read.rows.map((row) => stemOf(row.fileName))),
		]),
	);

	const findings: ReferenceFinding[] = [];

	for (const { name: table, read } of folders) {
		// Only a modeled folder has typed fields; a raw folder has no reference columns.
		if (read.view.mode !== 'modeled') continue;

		for (const field of read.view.model.fields) {
			const target = referenceTargetOf(field);
			if (target === null) continue; // not a reference column
			const targetStems = stemsByTable.get(target);
			if (targetStems === undefined) {
				// The whole column is unresolvable: report once and skip its rows. There is no
				// set to resolve against, so per-row findings would only echo one real cause.
				findings.push({ kind: 'MISSING_TARGET', table, field: field.name, target });
				continue;
			}

			for (const conformance of read.view.conformance) {
				const cell = conformance.cells.find((c) => c.field.name === field.name);
				// Only an OK cell carries a present, type-valid pointer. A missing or invalid
				// reference cell is already classified by conformance under the folder's own
				// policy; this pass resolves present pointers, it does not reclassify the rest. An
				// empty value is one of those already-classified cases: the reference contract
				// rejects "" as invalid, so it never arrives here as OK.
				if (cell?.state !== 'OK') continue;
				const value = cell.value;
				if (typeof value !== 'string') continue; // reference compiles as string; defensive
				if (targetStems.has(value)) continue;
				findings.push({
					kind: 'UNRESOLVED',
					table,
					file: conformance.row.fileName,
					field: field.name,
					target,
					value,
				});
			}
		}
	}

	return findings;
}
