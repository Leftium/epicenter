import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
} from '@codemirror/view';

type VisibleRange = {
	from: number;
	to: number;
};

type SyntaxContext = {
	name: string;
	from: number;
	to: number;
	isInlineLink?: boolean;
};

type MarkdownLivePreviewRange =
	| {
			type: 'hide';
			from: number;
			to: number;
	  }
	| {
			type: 'mark';
			from: number;
			to: number;
			className: string;
	  };

const headingPattern = /^ATXHeading([1-6])$/;

export function collectMarkdownLivePreviewRanges(
	state: EditorState,
	visibleRanges: readonly VisibleRange[],
): MarkdownLivePreviewRange[] {
	const activeLines = collectActiveLines(state);
	const ranges: MarkdownLivePreviewRange[] = [];

	for (const visibleRange of visibleRanges) {
		const contexts: SyntaxContext[] = [];

		syntaxTree(state).iterate({
			from: visibleRange.from,
			to: visibleRange.to,
			enter(node) {
				const name = node.type.name;
				const headingMatch = headingPattern.exec(name);
				const linkInfo =
					name === 'Link'
						? getInlineLinkInfo(
								state.doc.sliceString(node.from, node.to),
								node.from,
							)
						: null;

				if (headingMatch) {
					const level = headingMatch[1];
					const contentRange = getHeadingContentRange(
						state.doc.sliceString(node.from, node.to),
						node.from,
						node.to,
					);

					if (contentRange) {
						addMark(
							ranges,
							contentRange.from,
							contentRange.to,
							`cm-matter-md-heading cm-matter-md-heading-${level}`,
						);
					}
				}

				if (name === 'Emphasis' || name === 'StrongEmphasis') {
					const markerLength = name === 'StrongEmphasis' ? 2 : 1;
					addMark(
						ranges,
						node.from + markerLength,
						node.to - markerLength,
						name === 'StrongEmphasis'
							? 'cm-matter-md-strong'
							: 'cm-matter-md-emphasis',
					);
				}

				if (name === 'InlineCode') {
					const contentRange = getInlineCodeContentRange(
						state.doc.sliceString(node.from, node.to),
						node.from,
						node.to,
					);

					if (contentRange) {
						addMark(
							ranges,
							contentRange.from,
							contentRange.to,
							'cm-matter-md-inline-code',
						);
					}
				}

				if (linkInfo) {
					addMark(
						ranges,
						linkInfo.labelFrom,
						linkInfo.labelTo,
						'cm-matter-md-link',
					);
				}

				if (name === 'ListMark' || name === 'QuoteMark') {
					addMark(ranges, node.from, node.to, 'cm-matter-md-structural-marker');
				}

				const activeRange = getHideActiveRange(name, contexts);
				if (activeRange && !isActiveRange(state, activeLines, activeRange)) {
					addHide(ranges, state, node.from, node.to);
				}

				contexts.push({
					name,
					from: node.from,
					to: node.to,
					isInlineLink: linkInfo !== null,
				});
			},
			leave() {
				contexts.pop();
			},
		});
	}

	return uniqueSortedRanges(ranges);
}

export function markdownLivePreview(): Extension {
	return [markdownLivePreviewPlugin, markdownLivePreviewTheme];
}

const markdownLivePreviewPlugin = ViewPlugin.define(
	(view): PluginValue & { decorations: DecorationSet } => ({
		decorations: buildDecorations(view),
		update(update: ViewUpdate) {
			if (
				update.docChanged ||
				update.selectionSet ||
				update.viewportChanged ||
				syntaxTree(update.state) !== syntaxTree(update.startState)
			) {
				this.decorations = buildDecorations(update.view);
			}
		},
	}),
	{
		decorations: (plugin) => plugin.decorations,
	},
);

const markdownLivePreviewTheme = EditorView.baseTheme({
	'.cm-matter-md-heading': {
		fontWeight: '700',
		color: 'hsl(var(--foreground))',
	},
	'.cm-matter-md-heading-1': {
		fontSize: '1.25em',
	},
	'.cm-matter-md-heading-2': {
		fontSize: '1.15em',
	},
	'.cm-matter-md-heading-3': {
		fontSize: '1.08em',
	},
	'.cm-matter-md-heading-4, .cm-matter-md-heading-5, .cm-matter-md-heading-6': {
		fontSize: '1em',
	},
	'.cm-matter-md-strong': {
		fontWeight: '700',
	},
	'.cm-matter-md-emphasis': {
		fontStyle: 'italic',
	},
	'.cm-matter-md-inline-code': {
		borderRadius: '0.25rem',
		backgroundColor: 'hsl(var(--muted))',
		color: 'hsl(var(--foreground))',
		padding: '0.05rem 0.25rem',
	},
	'.cm-matter-md-link': {
		color: 'hsl(var(--primary))',
		textDecoration: 'underline',
		textDecorationColor: 'hsl(var(--primary) / 0.45)',
		textUnderlineOffset: '0.18em',
	},
	'.cm-matter-md-structural-marker': {
		color: 'hsl(var(--muted-foreground))',
		fontWeight: '500',
	},
});

function buildDecorations(view: EditorView): DecorationSet {
	return Decoration.set(
		collectMarkdownLivePreviewRanges(view.state, view.visibleRanges).map(
			(range) => {
				if (range.type === 'hide') {
					return Decoration.replace({}).range(range.from, range.to);
				}

				return Decoration.mark({ class: range.className }).range(
					range.from,
					range.to,
				);
			},
		),
		true,
	);
}

function collectActiveLines(state: EditorState): Set<number> {
	const activeLines = new Set<number>();

	for (const range of state.selection.ranges) {
		const fromLine = state.doc.lineAt(range.from).number;
		const toLine = state.doc.lineAt(range.to).number;

		for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
			activeLines.add(lineNumber);
		}
	}

	return activeLines;
}

function isActiveRange(
	state: EditorState,
	activeLines: Set<number>,
	range: VisibleRange,
): boolean {
	const fromLine = state.doc.lineAt(range.from).number;
	const toLine = state.doc.lineAt(range.to).number;

	for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
		if (activeLines.has(lineNumber)) return true;
	}

	return false;
}

function getHideActiveRange(
	name: string,
	contexts: readonly SyntaxContext[],
): VisibleRange | null {
	if (name === 'HeaderMark') {
		return getClosestContext(contexts, (context) =>
			headingPattern.test(context.name),
		);
	}

	if (name === 'EmphasisMark') {
		return getClosestContext(
			contexts,
			(context) =>
				context.name === 'Emphasis' || context.name === 'StrongEmphasis',
		);
	}

	if (name === 'CodeMark') {
		return getClosestContext(
			contexts,
			(context) => context.name === 'InlineCode',
		);
	}

	if (name !== 'LinkMark' && name !== 'URL' && name !== 'LinkTitle') {
		return null;
	}

	const context = getCurrentLinkContext(contexts);
	return context?.name === 'Link' && context.isInlineLink === true
		? context
		: null;
}

function getClosestContext(
	contexts: readonly SyntaxContext[],
	matches: (context: SyntaxContext) => boolean,
): SyntaxContext | null {
	for (let index = contexts.length - 1; index >= 0; index -= 1) {
		const context = contexts[index];
		if (context && matches(context)) return context;
	}

	return null;
}

function getCurrentLinkContext(
	contexts: readonly SyntaxContext[],
): SyntaxContext | undefined {
	for (let index = contexts.length - 1; index >= 0; index -= 1) {
		const context = contexts[index];
		if (
			context?.name === 'Link' ||
			context?.name === 'Image' ||
			context?.name === 'Autolink'
		) {
			return context;
		}
	}
}

function getInlineLinkInfo(
	text: string,
	nodeFrom: number,
): {
	labelFrom: number;
	labelTo: number;
} | null {
	const labelEnd = text.lastIndexOf('](');
	if (labelEnd <= 1 || !text.endsWith(')')) return null;

	return {
		labelFrom: nodeFrom + 1,
		labelTo: nodeFrom + labelEnd,
	};
}

function getHeadingContentRange(
	text: string,
	nodeFrom: number,
	nodeTo: number,
): VisibleRange | null {
	const opening = /^(#{1,6})[ \t]*/.exec(text);
	if (!opening) return null;

	const closing = /[ \t]+#{1,6}[ \t]*$/.exec(text);
	const from = nodeFrom + opening[0].length;
	const to = closing?.index === undefined ? nodeTo : nodeFrom + closing.index;

	return from < to ? { from, to } : null;
}

function getInlineCodeContentRange(
	text: string,
	nodeFrom: number,
	nodeTo: number,
): VisibleRange | null {
	const opening = /^`+/.exec(text);
	const closing = /`+$/.exec(text);
	if (!opening || !closing) return null;

	const from = nodeFrom + opening[0].length;
	const to = nodeTo - closing[0].length;

	return from < to ? { from, to } : null;
}

function addHide(
	ranges: MarkdownLivePreviewRange[],
	state: EditorState,
	from: number,
	to: number,
) {
	let cursor = from;

	while (cursor < to) {
		const line = state.doc.lineAt(cursor);
		const lineTo = Math.min(to, line.to);

		if (cursor < lineTo) {
			ranges.push({ type: 'hide', from: cursor, to: lineTo });
		}

		if (lineTo >= to) return;

		const nextLineNumber = line.number + 1;
		if (nextLineNumber > state.doc.lines) return;
		cursor = state.doc.line(nextLineNumber).from;
	}
}

function addMark(
	ranges: MarkdownLivePreviewRange[],
	from: number,
	to: number,
	className: string,
) {
	if (from >= to) return;
	ranges.push({ type: 'mark', from, to, className });
}

function uniqueSortedRanges(
	ranges: MarkdownLivePreviewRange[],
): MarkdownLivePreviewRange[] {
	const sortedRanges = ranges.toSorted(compareRanges);
	const uniqueRanges: MarkdownLivePreviewRange[] = [];
	const seen = new Set<string>();

	for (const range of sortedRanges) {
		const key =
			range.type === 'hide'
				? `${range.type}:${range.from}:${range.to}`
				: `${range.type}:${range.from}:${range.to}:${range.className}`;

		if (seen.has(key)) continue;
		seen.add(key);
		uniqueRanges.push(range);
	}

	return uniqueRanges;
}

function compareRanges(
	left: MarkdownLivePreviewRange,
	right: MarkdownLivePreviewRange,
): number {
	return (
		left.from - right.from ||
		left.to - right.to ||
		left.type.localeCompare(right.type) ||
		getRangeClassName(left).localeCompare(getRangeClassName(right))
	);
}

function getRangeClassName(range: MarkdownLivePreviewRange): string {
	return range.type === 'mark' ? range.className : '';
}
