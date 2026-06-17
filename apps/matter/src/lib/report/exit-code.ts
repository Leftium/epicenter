/**
 * The CLI exit code, derived from a {@link Summary}. Three tiers, by how badly the vault failed:
 *
 *   - `2` a table could not be loaded at all: `unreadable` (folder unreadable) or
 *         `invalid-contract` (matter.json present but corrupt). The check could not run over that
 *         table, so this is the fatal tier.
 *   - `1` every table loaded, but the data has problems: at least one modeled row needs attention
 *         (a missing required value, an invalid value, or an unresolved reference).
 *   - `0` everything loaded and every row is healthy. An `unmodeled` table (no matter.json) is a
 *         valid raw grid, never a failure, so a vault of only untyped tables still exits 0.
 *
 * A pure read of the roll-up totals: the same `needsAttention` the report text and the integrity
 * panel show, so the exit code can never disagree with what the user is told.
 */

import type { Summary } from './violations';

type ExitCode = 0 | 1 | 2;

export function exitCodeFor(summary: Summary): ExitCode {
	const { unreadable, invalidContract, needsAttention } = summary.totals;
	if (unreadable > 0 || invalidContract > 0) return 2;
	return needsAttention > 0 ? 1 : 0;
}
