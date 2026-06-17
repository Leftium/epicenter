/**
 * The per-tab SQL WHERE filter over a table's mirror.
 *
 * Bundles the three things a filter is, the input (`text`), the result
 * (`matchedFileNames`), and a bad-clause `error`, plus the debounced query and its own
 * reactive lifecycle, into ONE unit. TableGrid binds `filter.text` and reads
 * `filter.matchedFileNames` instead of carrying three loose `$state`s and a standing effect
 * a reader has to mentally group.
 *
 * The table is taken at construction (not per call): a tab's table is non-swappable (a
 * table switch remounts TablePane with a fresh table AND a fresh filter), so there is
 * nothing to re-point at call time. The filter owns its own `$effect`, which Svelte ties to
 * the component that constructs it (the same pattern as `createPressedKeys`), so the caller
 * just writes `const filter = createWhereFilter(table)`, with no effect to wire and no
 * cleanup to honor.
 *
 * The effect re-runs on two reactive reads: `text` (the clause) and `table.mirrorVersion`
 * (bumped after each rebuild of `matter.sqlite`). Keying on the mirror's version, not the
 * in-memory rows, means the query fires only once the file it reads is actually fresh, so a
 * data edit can never land a result from the pre-rebuild mirror. Each run debounces, and its
 * cleanup cancels the pending/in-flight query so a newer clause or rebuild never lands a
 * stale result set.
 */

import type { TableHandle } from './table.svelte';

/** Let a burst of keystrokes (or rapid external edits) settle before querying the mirror. */
const DEBOUNCE_MS = 200;

export function createWhereFilter(table: TableHandle) {
	let text = $state('');
	let matchedFileNames = $state<Set<string>>();
	let error = $state<string>();

	// Resolve the current clause to matched names whenever the clause or the mirror changes.
	// Reading `table.mirrorVersion` (discarded) is the subscription: it bumps after each
	// `matter.sqlite` rebuild, so the query below always reads a fresh file. The cleanup
	// cancels the pending/in-flight query so a newer clause or rebuild never lands a stale set.
	$effect(() => {
		const clause = text.trim();
		void table.mirrorVersion; // re-run after the mirror is rebuilt (downstream of row edits)
		// Empty clause: there is no filter, so show every row.
		if (!clause) {
			matchedFileNames = undefined;
			error = undefined;
			return;
		}
		let cancelled = false;
		const handle = setTimeout(async () => {
			const { data, error: failure } = await table.matchingFileNames(clause);
			if (cancelled) return; // a newer clause, a rebuild, or this tab being torn down won
			if (failure) error = failure.message;
			else {
				matchedFileNames = data;
				error = undefined;
			}
		}, DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(handle);
		};
	});

	return {
		/** The WHERE clause, two-way bound to the folder-header input. */
		get text() {
			return text;
		},
		set text(value: string) {
			text = value;
		},
		/** The names the clause matched, or `undefined` when no clause is active. */
		get matchedFileNames() {
			return matchedFileNames;
		},
		/** A bad clause's message; the last good `matchedFileNames` is kept until it parses. */
		get error() {
			return error;
		},
	};
}

/** A per-tab WHERE filter. The grid takes one to render its header input and narrow rows. */
export type WhereFilter = ReturnType<typeof createWhereFilter>;
