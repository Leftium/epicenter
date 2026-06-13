// PROTOTYPE - throwaway. Word-level diff for the Polish candidate-cards spike.
// Rough LCS over whitespace-preserving word tokens; not production quality.

export type DiffSegment = {
	type: 'equal' | 'insert' | 'delete';
	text: string;
};

/**
 * Word-level diff of `original` -> `candidate`. Splits on whitespace (keeping the
 * whitespace as its own tokens so spacing round-trips), then walks an LCS table to
 * tag each token equal / inserted (in candidate) / deleted (from original).
 */
export function wordDiff(original: string, candidate: string): DiffSegment[] {
	const a = original.split(/(\s+)/);
	const b = candidate.split(/(\s+)/);
	const m = a.length;
	const n = b.length;

	// Nullish fallbacks (?? 0 / ?? '') keep noUncheckedIndexedAccess happy without
	// non-null assertions; indices stay in bounds, so the fallbacks never fire.
	const at = (row: number[] | undefined, col: number) => row?.[col] ?? 0;
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array<number>(n + 1).fill(0),
	);
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			const row = dp[i];
			if (!row) continue;
			row[j] =
				a[i] === b[j]
					? at(dp[i + 1], j + 1) + 1
					: Math.max(at(dp[i + 1], j), at(dp[i], j + 1));
		}
	}

	const segments: DiffSegment[] = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) {
			segments.push({ type: 'equal', text: a[i] ?? '' });
			i++;
			j++;
		} else if (at(dp[i + 1], j) >= at(dp[i], j + 1)) {
			segments.push({ type: 'delete', text: a[i] ?? '' });
			i++;
		} else {
			segments.push({ type: 'insert', text: b[j] ?? '' });
			j++;
		}
	}
	while (i < m) segments.push({ type: 'delete', text: a[i++] ?? '' });
	while (j < n) segments.push({ type: 'insert', text: b[j++] ?? '' });
	return segments;
}
