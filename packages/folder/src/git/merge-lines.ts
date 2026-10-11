/**
 * The line merge sync uses for a row body and a text file both sides changed.
 *
 * Each side's changes against the base are diffed by line; changes that
 * overlap or touch on the base are one region. A region only one side
 * changed takes that side's lines, a region both sides changed identically
 * takes those lines, and any other region competes, so the whole merge is
 * `undefined` and the caller holds the unit for a person.
 */

/**
 * Lines ending at each line feed, the last without one. Every character
 * lands in a line, a lone carriage return, U+2028, and U+2029 included.
 */
const LINES = /[^\n]*\n|[^\n]+$/g;

const lines = (text: string) => text.match(LINES) ?? [];

/** One run of changed lines of a side, as half-open ranges of the base and the side. */
type Hunk = {
	readonly side: 'ours' | 'theirs';
	readonly baseStart: number;
	readonly baseEnd: number;
	readonly sideStart: number;
	readonly sideEnd: number;
};

/**
 * The line merge of three texts, or `undefined` when both sides changed the
 * same lines differently. Every input byte of a kept line lands in the
 * output, so a body with no line break at its end keeps that.
 */
export async function mergeLines({
	base,
	ours,
	theirs,
}: {
	base: string;
	ours: string;
	theirs: string;
}): Promise<string | undefined> {
	// Loaded when a merge needs it: the shell's diff uses the same library,
	// and a static import would put it in this module's chunk.
	const { diffArrays } = await import('diff');
	const [b, o, t] = [lines(base), lines(ours), lines(theirs)] as const;

	function hunks(side: Hunk['side'], changed: readonly string[]): Hunk[] {
		const found: Hunk[] = [];
		let open: { -readonly [K in keyof Hunk]: Hunk[K] } | undefined;
		let atBase = 0;
		let atSide = 0;
		for (const change of diffArrays([...b], [...changed])) {
			if (!change.added && !change.removed) {
				if (open !== undefined) found.push(open);
				open = undefined;
				atBase += change.count;
				atSide += change.count;
				continue;
			}
			open ??= {
				side,
				baseStart: atBase,
				baseEnd: atBase,
				sideStart: atSide,
				sideEnd: atSide,
			};
			if (change.removed) open.baseEnd = atBase += change.count;
			else open.sideEnd = atSide += change.count;
		}
		if (open !== undefined) found.push(open);
		return found;
	}

	const all = [...hunks('ours', o), ...hunks('theirs', t)].sort(
		(left, right) =>
			left.baseStart - right.baseStart || left.baseEnd - right.baseEnd,
	);
	let merged = '';
	let cursor = 0;
	for (let index = 0; index < all.length; ) {
		const start = all[index]!.baseStart;
		let end = all[index]!.baseEnd;
		const group = [all[index++]!];
		while (index < all.length && all[index]!.baseStart <= end) {
			end = Math.max(end, all[index]!.baseEnd);
			group.push(all[index++]!);
		}
		merged += b.slice(cursor, start).join('');
		cursor = end;
		/** The side's lines standing where the base has `start` to `end`. */
		const across = (side: Hunk['side']) => {
			const own = group.filter((hunk) => hunk.side === side);
			if (own.length === 0) return b.slice(start, end).join('');
			const first = own[0]!;
			const last = own[own.length - 1]!;
			return (side === 'ours' ? o : t)
				.slice(
					first.sideStart - (first.baseStart - start),
					last.sideEnd + (end - last.baseEnd),
				)
				.join('');
		};
		const [mine, yours] = [across('ours'), across('theirs')];
		if (mine === yours || group.every((hunk) => hunk.side === 'ours'))
			merged += mine;
		else if (group.every((hunk) => hunk.side === 'theirs')) merged += yours;
		else return undefined;
	}
	return merged + b.slice(cursor).join('');
}
