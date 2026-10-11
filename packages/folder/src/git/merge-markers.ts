/**
 * Git's ordinary conflict markers for one text file both sides of a merge
 * changed, for a merge left for a person to finish.
 *
 * `mergeLines` applies the same region rules and answers `undefined` where
 * `conflictMarkers` would mark a region; sync merges a row body with it.
 *
 * Lines split the way isomorphic-git splits them for its own text merge, so
 * every input byte lands in the output. Each side's changes against the base
 * are diffed by line; changes that overlap or touch on the base are one
 * region. A region only one side changed takes that side's lines, a region
 * both sides changed identically takes those lines, and any other region is
 * written as
 *
 * ```text
 * <<<<<<< HEAD
 * ours
 * =======
 * theirs
 * >>>>>>> origin/main
 * ```
 *
 * A marker always starts a line: a side whose last line has no line break
 * gets one before the next marker. The caller has already decided the file
 * conflicts, so a merge whose regions all resolve still gets one region
 * spanning both whole sides; a person always finds markers in it.
 *
 * isomorphic-git 1.38.5 does not return its own markers. Its default merge
 * driver is not exported, and with `abortOnConflict: false` its merge writes
 * every file of the merged tree, decoded as text, into a working directory
 * and an index, then throws without naming the tree. Reading markers from
 * there would mean a scratch working directory, index, and refs, and
 * decoding every file of the folder, audio included, for one text file.
 */

/**
 * Lines ending at each line feed, the last without one. Every character
 * lands in a line, a lone carriage return, U+2028, and U+2029 included. For
 * text whose only breaks are LF and CRLF, which is all a Git merge here
 * leaves markers in, these are isomorphic-git's own lines.
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

/** The labels Git writes after the opening and closing markers. */
export type MarkerLabels = { readonly ours: string; readonly theirs: string };

/** `lines`, ending in a line break so the marker after them starts a line. */
function terminated(text: readonly string[]): string {
	const joined = text.join('');
	return joined === '' || joined.endsWith('\n') ? joined : `${joined}\n`;
}

function markedRegion(
	labels: MarkerLabels,
	ours: readonly string[],
	theirs: readonly string[],
) {
	return `<<<<<<< ${labels.ours}\n${terminated(ours)}=======\n${terminated(theirs)}>>>>>>> ${labels.theirs}\n`;
}

/**
 * The three versions split into regions: lines both sides keep from the
 * base or changed alike, and competing regions with each side's lines.
 */
async function regions({
	base,
	ours,
	theirs,
}: {
	base: string;
	ours: string;
	theirs: string;
}): Promise<
	(
		| { readonly kind: 'clean'; readonly lines: string }
		| {
				readonly kind: 'competing';
				readonly ours: readonly string[];
				readonly theirs: readonly string[];
		  }
	)[]
> {
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
	const found: Awaited<ReturnType<typeof regions>> = [];
	let cursor = 0;
	for (let index = 0; index < all.length; ) {
		const start = all[index]!.baseStart;
		let end = all[index]!.baseEnd;
		const group = [all[index++]!];
		while (index < all.length && all[index]!.baseStart <= end) {
			end = Math.max(end, all[index]!.baseEnd);
			group.push(all[index++]!);
		}
		found.push({ kind: 'clean', lines: b.slice(cursor, start).join('') });
		cursor = end;
		/** The side's lines standing where the base has `start` to `end`. */
		const across = (side: Hunk['side']) => {
			const own = group.filter((hunk) => hunk.side === side);
			if (own.length === 0) return b.slice(start, end);
			const first = own[0]!;
			const last = own[own.length - 1]!;
			return (side === 'ours' ? o : t).slice(
				first.sideStart - (first.baseStart - start),
				last.sideEnd + (end - last.baseEnd),
			);
		};
		const [mine, yours] = [across('ours'), across('theirs')];
		if (
			mine.join('') === yours.join('') ||
			group.every((hunk) => hunk.side === 'ours')
		)
			found.push({ kind: 'clean', lines: mine.join('') });
		else if (group.every((hunk) => hunk.side === 'theirs'))
			found.push({ kind: 'clean', lines: yours.join('') });
		else found.push({ kind: 'competing', ours: mine, theirs: yours });
	}
	found.push({ kind: 'clean', lines: b.slice(cursor).join('') });
	return found;
}

/**
 * The line merge of three texts, or `undefined` when both sides changed the
 * same lines differently. Every input byte of a kept line lands in the
 * output, so a body with no line break at its end keeps that.
 */
export async function mergeLines(versions: {
	base: string;
	ours: string;
	theirs: string;
}): Promise<string | undefined> {
	let merged = '';
	for (const region of await regions(versions)) {
		if (region.kind === 'competing') return undefined;
		merged += region.lines;
	}
	return merged;
}

/** The text a person resolves: clean regions merged, competing regions marked. */
export async function conflictMarkers(
	versions: { base: string; ours: string; theirs: string },
	labels: MarkerLabels,
): Promise<string> {
	let merged = '';
	let marked = false;
	for (const region of await regions(versions)) {
		if (region.kind === 'clean') merged += region.lines;
		else {
			marked = true;
			merged += markedRegion(labels, region.ours, region.theirs);
		}
	}
	return marked
		? merged
		: markedRegion(labels, lines(versions.ours), lines(versions.theirs));
}
