/**
 * A capture's Markdown, read as the capture text and its ordered thoughts.
 *
 * The source string is the only representation. markdown-it decides what the
 * blocks are and which source lines each one owns; this module maps those line
 * ranges to offsets and replaces one span at a time. Every result is parsed
 * again and accepted only if it reads back as exactly the intended text and
 * thoughts, so a splice can never be absorbed by an unclosed code fence, merge
 * two blocks, or change a thought it did not name. Bytes outside the replaced
 * span are not rewritten.
 *
 * The layout:
 *
 *   ---
 *   capturedAt: 2026-10-01T10:30:00+08:00
 *   ---
 *
 *   The capture text.
 *
 *   ## Thoughts
 *
 *   - First thought.
 *   - Another thought.
 *     It can continue across lines, and nest.
 *
 * - The capture text is everything between the frontmatter and the one
 *   root-level `## Thoughts` heading. With no such heading it is the whole
 *   body, and adding a thought appends the section.
 * - Thoughts are the items of the one bullet list directly under that
 *   heading. Whatever an item owns in Markdown (continuation lines, later
 *   paragraphs, nested lists, code) is part of that thought.
 * - Blocks after that list, and everything from the next root heading on, are
 *   kept and never read as thoughts.
 * - A thought is a span in this source. It has an index, not an identity, and
 *   belongs to the one parse that produced it. An operation takes a thought
 *   of the document it is given and refuses one from any other parse.
 *
 * Structured operations are refused, with the reason, when the layout is
 * ambiguous: more than one root heading reading "Thoughts", a Thoughts
 * heading that is not `## Thoughts`, anything but a bullet list first under
 * the heading, a second bullet list in the section, or frontmatter with no
 * closing line. The source stays editable as text.
 */
import { frameSource } from '@epicenter/app/files';
import MarkdownIt from 'markdown-it';

export type Newline = '\n' | '\r\n';

export type Thought = {
	/** Position among this document's thoughts. */
	readonly index: number;
	/** The item's Markdown with its marker and indentation removed, LF lines. */
	readonly text: string;
};

export type RefusalCode =
	| 'unclosed-frontmatter'
	| 'duplicate-heading'
	| 'heading-form'
	| 'section-shape'
	| 'empty'
	| 'stale'
	| 'unverified';

export type Refusal = { readonly code: RefusalCode; readonly message: string };

export type Edit =
	| { readonly ok: true; readonly source: string }
	| { readonly ok: false; readonly refusal: Refusal };

type Span = { readonly start: number; readonly end: number };

type ItemSpan = Span & {
	/** The item's leading whitespace on its marker line. */
	readonly lead: string;
	readonly marker: string;
};

/** Offsets into `source`. Meaningful only with the document that holds them. */
type Layout = {
	readonly bodyStart: number;
	/** The capture text's exact span. */
	readonly text: Span;
	/** Start of the heading line, or the end of the source. */
	readonly regionEnd: number;
	readonly hasFrontmatter: boolean;
	/** The `## Thoughts` line, without its terminator. */
	readonly heading: Span | undefined;
	readonly items: readonly ItemSpan[];
};

export type CaptureDocument = {
	readonly source: string;
	/** The line ending new lines are written with. */
	readonly newline: Newline;
	/** Why structured editing is unavailable, when it is. */
	readonly refusal: Refusal | undefined;
	/** The capture text with LF lines; `undefined` when refused. */
	readonly text: string | undefined;
	/** Empty when refused or when there is no Thoughts section. */
	readonly thoughts: readonly Thought[];
	/** Whether the source has its `## Thoughts` heading. */
	readonly hasSection: boolean;
	/**
	 * Whether the source holds Markdown the structured view does not show:
	 * blocks after the thoughts list, or anything from the next heading on.
	 */
	readonly hasOtherContent: boolean;
	/** Internal offsets for the operations below. */
	readonly layout: Layout | undefined;
};

const THOUGHTS = 'thoughts';
const markdown = new MarkdownIt('commonmark');

// ============================================================================
// Lines
// ============================================================================

type Line = {
	readonly start: number;
	/** End of the line's content, before its terminator. */
	readonly end: number;
};

/** The same lines markdown-it counts: `\r\n`, `\n`, and a lone `\r` each end one. */
function lineTable(source: string, from: number): Line[] {
	const lines: Line[] = [];
	let start = from;
	while (start <= source.length) {
		let end = start;
		while (end < source.length && source[end] !== '\n' && source[end] !== '\r')
			end++;
		lines.push({ start, end });
		if (end >= source.length) break;
		start = end + (source[end] === '\r' && source[end + 1] === '\n' ? 2 : 1);
	}
	return lines;
}

/** A line's content with up to `columns` of leading whitespace removed. */
function dedent(text: string, columns: number): string {
	let column = 0;
	let cursor = 0;
	while (
		cursor < text.length &&
		column < columns &&
		(text[cursor] === ' ' || text[cursor] === '\t')
	) {
		column += text[cursor] === '\t' ? 4 - (column % 4) : 1;
		cursor++;
	}
	return text.slice(cursor);
}

/** Text as a textarea shows it: every line ending is a line feed. */
export function toTextarea(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

// ============================================================================
// Reading
// ============================================================================

const TERMINATOR = /(?:\r\n|\n|\r)$/;

function refused(
	source: string,
	newline: Newline,
	code: RefusalCode,
	message: string,
): CaptureDocument {
	return {
		source,
		newline,
		refusal: { code, message },
		text: undefined,
		thoughts: [],
		hasSection: false,
		hasOtherContent: false,
		layout: undefined,
	};
}

/** A root block as markdown-it reported it. */
type RootBlock = {
	readonly type: string;
	readonly first: number;
	/** Exclusive. */
	readonly last: number;
	readonly markup: string;
	readonly tag: string;
	/** A heading's text. */
	readonly content: string;
	/** A list's direct items, as line ranges. */
	readonly items: readonly { readonly first: number; readonly last: number }[];
};

function rootBlocks(body: string): RootBlock[] {
	const tokens = markdown.parse(body, {});
	const blocks: RootBlock[] = [];
	for (let at = 0; at < tokens.length; at++) {
		const token = tokens[at];
		if (token === undefined || token.level !== 0 || token.nesting < 0) continue;
		if (token.map === null) continue;
		const items: { first: number; last: number }[] = [];
		let content = '';
		if (token.type === 'heading_open') content = tokens[at + 1]?.content ?? '';
		if (token.type === 'bullet_list_open')
			for (let inner = at + 1; inner < tokens.length; inner++) {
				const child = tokens[inner];
				if (child === undefined || child.level === 0) break;
				if (
					child.type === 'list_item_open' &&
					child.level === 1 &&
					child.map !== null
				)
					items.push({ first: child.map[0], last: child.map[1] });
			}
		blocks.push({
			type: token.type,
			first: token.map[0],
			last: token.map[1],
			markup: token.markup,
			tag: token.tag,
			content,
			items,
		});
	}
	return blocks;
}

export function parseCapture(source: string): CaptureDocument {
	const frame = frameSource(source);
	if (frame.kind === 'unclosed')
		return refused(
			source,
			source.includes('\r\n') ? '\r\n' : '\n',
			'unclosed-frontmatter',
			'The frontmatter opening line has no closing --- line.',
		);
	const { bodyStart, newline } = frame;
	const hasFrontmatter = frame.kind === 'frontmatter';
	const lines = lineTable(source, bodyStart);
	const blocks = rootBlocks(source.slice(bodyStart));
	const lineText = (at: number) => {
		const line = lines[at] as Line;
		return source.slice(line.start, line.end);
	};

	const named = blocks.filter(
		(block) =>
			block.type === 'heading_open' &&
			block.content.trim().toLowerCase() === THOUGHTS,
	);
	if (named.length > 1)
		return refused(
			source,
			newline,
			'duplicate-heading',
			`${named.length} headings read "Thoughts". The thoughts list needs exactly one.`,
		);
	const heading = named[0];
	if (
		heading !== undefined &&
		(heading.tag !== 'h2' ||
			!heading.markup.startsWith('#') ||
			!lineText(heading.first).startsWith('##'))
	)
		return refused(
			source,
			newline,
			'heading-form',
			'The Thoughts heading must be written as "## Thoughts" at the start of a line.',
		);

	const headingLine =
		heading === undefined ? undefined : (lines[heading.first] as Line);
	const regionEnd = headingLine?.start ?? source.length;

	// The capture text, between its separators: one blank line after
	// frontmatter, and one before the heading.
	let textStart = bodyStart;
	if (hasFrontmatter) {
		const lead = /^(?:\r\n|\n|\r)/.exec(source.slice(bodyStart, regionEnd));
		if (lead) textStart += lead[0].length;
	}
	let textEnd = regionEnd;
	if (headingLine !== undefined)
		for (let count = 0; count < 2; count++) {
			const trail = TERMINATOR.exec(source.slice(textStart, textEnd));
			if (!trail) break;
			textEnd -= trail[0].length;
		}

	const items: ItemSpan[] = [];
	const thoughts: Thought[] = [];
	let hasOtherContent = false;
	if (heading !== undefined) {
		const from = blocks.indexOf(heading) + 1;
		let to = from;
		while (to < blocks.length && blocks[to]?.type !== 'heading_open') to++;
		const section = blocks.slice(from, to);
		const list = section[0];
		if (
			list !== undefined &&
			(list.type !== 'bullet_list_open' ||
				section.slice(1).some((block) => block.type === 'bullet_list_open'))
		)
			return refused(
				source,
				newline,
				'section-shape',
				list.type !== 'bullet_list_open'
					? 'The Thoughts section must start with its bulleted list. Other Markdown sits between the heading and the list, so it is unclear which items are thoughts.'
					: 'The Thoughts section holds more than one bulleted list, so it is unclear which items are thoughts.',
			);
		hasOtherContent = to < blocks.length || section.length > 1;
		for (const item of list?.items ?? []) {
			// markdown-it's range can run past the item's last line of content.
			let last = Math.min(item.last, lines.length) - 1;
			while (last > item.first && lineText(last).trim() === '') last--;
			const first = lineText(item.first);
			const match = /^([ \t]*)([-*+])([ \t]*)(.*)$/.exec(first);
			if (match === null) continue;
			const [, lead = '', marker = '-', gap = '', content = ''] = match;
			let column = 0;
			for (const char of lead) column += char === '\t' ? 4 - (column % 4) : 1;
			column += marker.length;
			let gapColumns = 0;
			for (const char of gap) {
				const width = char === '\t' ? 4 - ((column + gapColumns) % 4) : 1;
				gapColumns += width;
			}
			// Five or more columns after the marker begin indented code in the item.
			const contentIndent =
				column + (content === '' || gapColumns >= 5 ? 1 : gapColumns);
			const body = [content];
			for (let at = item.first + 1; at <= last; at++) {
				const line = lineText(at);
				body.push(line.trim() === '' ? '' : dedent(line, contentIndent));
			}
			items.push({
				start: (lines[item.first] as Line).start,
				end: (lines[last] as Line).end,
				lead,
				marker,
			});
			thoughts.push({ index: thoughts.length, text: body.join('\n') });
		}
	}

	return {
		source,
		newline,
		refusal: undefined,
		text: toTextarea(source.slice(textStart, textEnd)),
		thoughts,
		hasSection: heading !== undefined,
		hasOtherContent,
		layout: {
			bodyStart,
			text: { start: textStart, end: textEnd },
			regionEnd,
			hasFrontmatter,
			heading:
				headingLine === undefined
					? undefined
					: { start: headingLine.start, end: headingLine.end },
			items,
		},
	};
}

// ============================================================================
// Textarea input
// ============================================================================

/**
 * Carry a textarea's value back into text that may use other line endings.
 *
 * A textarea reports every line ending as a line feed. Replacing the original
 * with that value would rewrite every CRLF in the file. Instead, the unchanged
 * start and end of the value are matched against the original, those parts of
 * the original are kept byte for byte, and only the changed middle is written,
 * with `newline` for its line endings.
 */
export function fromTextarea(
	original: string,
	value: string,
	newline: Newline,
): string {
	// offsets[k] is where the k-th character of the textarea form sits in `original`.
	const offsets: number[] = [];
	let shown = '';
	for (let at = 0; at < original.length; at++) {
		offsets.push(at);
		if (original[at] === '\r') {
			shown += '\n';
			if (original[at + 1] === '\n') at++;
		} else shown += original[at];
	}
	offsets.push(original.length);
	const incoming = toTextarea(value);
	if (incoming === shown) return original;
	const limit = Math.min(shown.length, incoming.length);
	let prefix = 0;
	while (prefix < limit && shown[prefix] === incoming[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < limit - prefix &&
		shown[shown.length - 1 - suffix] === incoming[incoming.length - 1 - suffix]
	)
		suffix++;
	const middle = incoming.slice(prefix, incoming.length - suffix);
	return (
		original.slice(0, offsets[prefix]) +
		(newline === '\n' ? middle : middle.replace(/\n/g, newline)) +
		original.slice(offsets[shown.length - suffix])
	);
}

// ============================================================================
// Operations
// ============================================================================

const refuse = (code: RefusalCode, message: string): Edit => ({
	ok: false,
	refusal: { code, message },
});

/** A thought's text as it is stored: LF lines, no blank edges, no whitespace-only lines. */
export function normalizeThought(text: string): string {
	const lines = toTextarea(text)
		.split('\n')
		.map((line) => (line.trim() === '' ? '' : line));
	while (lines.length > 0 && lines[0] === '') lines.shift();
	while (lines.length > 0 && lines.at(-1) === '') lines.pop();
	return lines.join('\n');
}

function renderItem(
	lead: string,
	marker: string,
	text: string,
	newline: Newline,
): string {
	const [first = '', ...rest] = text.split('\n');
	const indent = `${lead}${' '.repeat(marker.length + 1)}`;
	return [
		`${lead}${marker}${first === '' ? '' : ` ${first}`}`,
		...rest.map((line) => (line === '' ? '' : `${indent}${line}`)),
	].join(newline);
}

/** One thought written as a root-level bullet item. */
export function renderThought(text: string, newline: Newline = '\n'): string {
	return renderItem('', '-', normalizeThought(text), newline);
}

function sameThoughts(
	actual: readonly Thought[],
	expected: readonly string[],
): boolean {
	return (
		actual.length === expected.length &&
		actual.every((thought, index) => thought.text === expected[index])
	);
}

/** Why `source` does not read back as exactly this text and these thoughts. */
function readsBack(
	source: string,
	expected: { text: string; thoughts: readonly string[] },
): Refusal | undefined {
	const result = parseCapture(source);
	if (result.refusal !== undefined) return result.refusal;
	if (
		result.text !== expected.text ||
		!sameThoughts(result.thoughts, expected.thoughts)
	)
		return {
			code: 'unverified',
			message:
				'Markdown around it, such as an unclosed code fence or HTML comment, would absorb or change it.',
		};
	return undefined;
}

/**
 * Accept `source` only if it reads back as intended. This is what makes a
 * splice safe: whatever the surrounding Markdown does to it, the result is
 * checked, not assumed.
 */
function verified(
	source: string,
	expected: { text: string; thoughts: readonly string[] },
	what: string,
): Edit {
	const problem = readsBack(source, expected);
	if (problem === undefined) return { ok: true, source };
	return refuse(
		'unverified',
		`${what} would not read back as written. ${problem.message}`,
	);
}

function ready(
	document: CaptureDocument,
): { layout: Layout; text: string } | Refusal {
	if (document.refusal !== undefined) return document.refusal;
	return {
		layout: document.layout as Layout,
		text: document.text as string,
	};
}

const splice = (source: string, span: Span, replacement: string) =>
	source.slice(0, span.start) + replacement + source.slice(span.end);

/**
 * Replace the capture text. `text` is a textarea value.
 *
 * The separators around the text are kept as they are. Only when the text
 * could not read back between them (text ending in a line break before a
 * heading with no blank line, for example) are they written as one blank line
 * after frontmatter and one before the heading.
 */
export function setText(document: CaptureDocument, text: string): Edit {
	const state = ready(document);
	if ('code' in state) return { ok: false, refusal: state };
	const { layout } = state;
	const { source, newline } = document;
	const current = source.slice(layout.text.start, layout.text.end);
	const next = fromTextarea(current, text, newline);
	if (next === current) return { ok: true, source };
	const expected = {
		text: toTextarea(next),
		thoughts: document.thoughts.map((thought) => thought.text),
	};
	const kept = splice(source, layout.text, next);
	if (readsBack(kept, expected) === undefined)
		return { ok: true, source: kept };
	return verified(
		splice(
			source,
			{ start: layout.bodyStart, end: layout.regionEnd },
			(layout.hasFrontmatter ? newline : '') +
				next +
				(layout.heading === undefined ? '' : `${newline}${newline}`),
		),
		expected,
		'This text',
	);
}

/** Append a thought, adding the `## Thoughts` section when there is none. */
export function addThought(document: CaptureDocument, text: string): Edit {
	const state = ready(document);
	if ('code' in state) return { ok: false, refusal: state };
	const { layout } = state;
	const { source, newline } = document;
	const thought = normalizeThought(text);
	if (thought === '') return refuse('empty', 'Write something first.');
	const thoughts = [...document.thoughts.map((item) => item.text), thought];

	const last = layout.items.at(-1);
	if (last !== undefined) {
		// Follow the list's own spacing: a blank line if its items are separated by one.
		const previous = layout.items.at(-2);
		const loose =
			previous !== undefined &&
			/\n[ \t]*\n/.test(toTextarea(source.slice(previous.end, last.start)));
		let next = splice(
			source,
			{ start: last.end, end: last.end },
			`${newline}${loose ? newline : ''}${renderItem(last.lead, last.marker, thought, newline)}`,
		);
		if (last.end === source.length) next += newline;
		return verified(next, { text: state.text, thoughts }, 'This thought');
	}
	if (layout.heading !== undefined) {
		const at = layout.heading.end;
		let next = splice(
			source,
			{ start: at, end: at },
			`${newline}${newline}${renderItem('', '-', thought, newline)}`,
		);
		if (at === source.length) next += newline;
		return verified(next, { text: state.text, thoughts }, 'This thought');
	}

	// No section yet: the existing bytes stay, and the section follows them.
	const body = source.slice(layout.bodyStart);
	const gap =
		body === ''
			? layout.hasFrontmatter
				? newline
				: ''
			: /\n[ \t]*\n$/.test(toTextarea(body)) ||
					/^[ \t]*\n$/.test(toTextarea(body))
				? ''
				: TERMINATOR.test(body)
					? newline
					: `${newline}${newline}`;
	const next = `${source}${gap}## Thoughts${newline}${newline}${renderItem('', '-', thought, newline)}${newline}`;
	// The text ran to the end of the file; with the section it ends before the
	// separator. Its bytes are untouched, so compare without trailing lines.
	const result = parseCapture(next);
	const trimmed = (value: string | undefined) =>
		(value ?? '').replace(/\n+$/, '');
	if (
		result.refusal !== undefined ||
		!result.hasSection ||
		!sameThoughts(result.thoughts, thoughts) ||
		trimmed(result.text) !== trimmed(state.text)
	)
		return refuse(
			'unverified',
			'A Thoughts section added here would not read back as written. Markdown above it, such as an unclosed code fence or HTML comment, would absorb it.',
		);
	return { ok: true, source: next };
}

const STALE = refuse(
	'stale',
	'The capture changed since this thought was shown. Nothing was changed.',
);

/**
 * The span of a thought, if `seen` is one of this document's own thoughts.
 *
 * A thought is bound to the parse that produced it: the check is object
 * identity, not index or text. A thought taken from any other parse is
 * refused before a span is touched, even when the same text sits at the same
 * index, so a selection can never be carried across a change of source.
 */
function itemFor(
	document: CaptureDocument,
	layout: Layout,
	seen: Thought,
): ItemSpan | undefined {
	if (document.thoughts[seen.index] !== seen) return undefined;
	return layout.items[seen.index];
}

/** Replace one thought's text. Only that item's span is rewritten. */
export function editThought(
	document: CaptureDocument,
	seen: Thought,
	text: string,
): Edit {
	const state = ready(document);
	if ('code' in state) return { ok: false, refusal: state };
	const item = itemFor(document, state.layout, seen);
	if (item === undefined) return STALE;
	const thought = normalizeThought(text);
	if (thought === '')
		return refuse('empty', 'A thought needs text. Delete it instead.');
	if (thought === seen.text) return { ok: true, source: document.source };
	return verified(
		splice(
			document.source,
			item,
			renderItem(item.lead, item.marker, thought, document.newline),
		),
		{
			text: state.text,
			thoughts: document.thoughts.map((other) =>
				other.index === seen.index ? thought : other.text,
			),
		},
		'This thought',
	);
}

/** Remove one thought and the separator that belonged to it. */
export function deleteThought(document: CaptureDocument, seen: Thought): Edit {
	const state = ready(document);
	if ('code' in state) return { ok: false, refusal: state };
	const { layout } = state;
	const { source } = document;
	const item = itemFor(document, layout, seen);
	if (item === undefined) return STALE;
	const following = layout.items[seen.index + 1];
	const preceding = layout.items[seen.index - 1];
	let span: Span;
	if (following !== undefined)
		span = { start: item.start, end: following.start };
	else if (preceding !== undefined)
		span = { start: preceding.end, end: item.end };
	else {
		const terminator = /^(?:\r\n|\n|\r)/.exec(source.slice(item.end));
		span = { start: item.start, end: item.end + (terminator?.[0].length ?? 0) };
	}
	return verified(
		splice(source, span, ''),
		{
			text: state.text,
			thoughts: document.thoughts
				.filter((other) => other.index !== seen.index)
				.map((other) => other.text),
		},
		'Removing this thought',
	);
}

/**
 * Exchange two neighbouring thoughts. Each keeps its own bytes, and the
 * separator between them stays where it is. Both must be as the caller saw
 * them.
 */
export function swapThoughts(
	document: CaptureDocument,
	seen: Thought,
	neighbour: Thought,
): Edit {
	const state = ready(document);
	if ('code' in state) return { ok: false, refusal: state };
	const { layout } = state;
	const { source } = document;
	if (Math.abs(seen.index - neighbour.index) !== 1) return STALE;
	const [first, second] =
		seen.index < neighbour.index ? [seen, neighbour] : [neighbour, seen];
	const upper = itemFor(document, layout, first);
	const lower = itemFor(document, layout, second);
	if (upper === undefined || lower === undefined) return STALE;
	const order = document.thoughts.map((thought) => thought.text);
	order[first.index] = second.text;
	order[second.index] = first.text;
	return verified(
		source.slice(0, upper.start) +
			source.slice(lower.start, lower.end) +
			source.slice(upper.end, lower.start) +
			source.slice(upper.start, upper.end) +
			source.slice(lower.end),
		{ text: state.text, thoughts: order },
		'Moving this thought',
	);
}

// ============================================================================
// New captures
// ============================================================================

/**
 * The Markdown body for a new capture: the text exactly as given (a textarea
 * value, or an imported body), then the Thoughts section with any thoughts.
 * The text's bytes are always written whole and in order.
 *
 * What the capture is when created is what it is when opened again:
 *
 * - Ordinary text reads back as that text and those thoughts.
 * - Text with its own "Thoughts" heading makes two headings. `refusal` says
 *   so, and it stays refused on reopening: the original's list is never read
 *   as this app's thoughts.
 * - Text that leaves a code fence or HTML block open absorbs the section.
 *   `absorbed` is true; the section is in the file and appears once the text
 *   above it is closed.
 * - Text that does both (its own Thoughts list, then an open fence) would
 *   absorb the second heading and leave its own list reading as thoughts.
 *   Only then, one empty `## Thoughts` heading is written before the text, so
 *   the file has two visible headings and stays refused.
 */
export function composeBody(
	text: string,
	thoughts: readonly string[] = [],
): {
	readonly body: string;
	readonly refusal: Refusal | undefined;
	readonly absorbed: boolean;
} {
	const expected = thoughts.map(normalizeThought);
	const list =
		expected.length === 0
			? ''
			: `\n${expected.map((thought) => renderThought(thought)).join('\n')}\n`;
	const frame = '---\nx: 0\n---\n';
	const body = `\n${text}\n\n## Thoughts\n${list}`;
	const read = parseCapture(frame + body);
	if (read.refusal !== undefined)
		return { body, refusal: read.refusal, absorbed: false };
	if (
		read.hasSection &&
		read.text === toTextarea(text) &&
		sameThoughts(read.thoughts, expected)
	)
		return { body, refusal: undefined, absorbed: false };
	// The section was absorbed. With no heading left to read, the file has no
	// thoughts and says so. A heading still read is the text's own.
	if (!read.hasSection) return { body, refusal: undefined, absorbed: true };
	const marked = `\n## Thoughts\n${body}`;
	const reread = parseCapture(frame + marked);
	return reread.refusal?.code === 'duplicate-heading'
		? { body: marked, refusal: reread.refusal, absorbed: true }
		: { body, refusal: undefined, absorbed: true };
}

/** A short excerpt of the capture text for a list. */
export function excerpt(document: CaptureDocument, limit = 240): string {
	const full = (document.text ?? toTextarea(document.source)).trim();
	if (full.length <= limit) return full;
	return `${full.slice(0, limit).trimEnd()}…`;
}
