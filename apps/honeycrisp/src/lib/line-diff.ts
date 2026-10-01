/**
 * A line-by-line comparison of two texts, for reviewing a draft against the
 * saved file. Longest common subsequence over lines; fine for notes, not
 * meant for very large files.
 */
export type DiffLine = {
	readonly kind: 'same' | 'removed' | 'added';
	readonly text: string;
};

const lines = (text: string) => (text === '' ? [] : text.split(/\r?\n/));

/** `removed` lines are only in `before`; `added` lines are only in `after`. */
export function diffLines(before: string, after: string): DiffLine[] {
	const left = lines(before);
	const right = lines(after);
	// Above this size, show both sides whole rather than build a large table.
	if (left.length * right.length > 4_000_000)
		return [
			...left.map((text) => ({ kind: 'removed' as const, text })),
			...right.map((text) => ({ kind: 'added' as const, text })),
		];
	const width = right.length + 1;
	const table = new Uint32Array((left.length + 1) * width);
	for (let i = left.length - 1; i >= 0; i -= 1)
		for (let j = right.length - 1; j >= 0; j -= 1)
			table[i * width + j] =
				left[i] === right[j]
					? table[(i + 1) * width + j + 1]! + 1
					: Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
	const result: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		if (left[i] === right[j]) {
			result.push({ kind: 'same', text: left[i]! });
			i += 1;
			j += 1;
		} else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
			result.push({ kind: 'removed', text: left[i]! });
			i += 1;
		} else {
			result.push({ kind: 'added', text: right[j]! });
			j += 1;
		}
	}
	for (; i < left.length; i += 1)
		result.push({ kind: 'removed', text: left[i]! });
	for (; j < right.length; j += 1)
		result.push({ kind: 'added', text: right[j]! });
	return result;
}
