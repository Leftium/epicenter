import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
} from '@codemirror/view';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';

type Span = {
	from: number;
	to: number;
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
	visibleRanges: readonly Span[],
): MarkdownLivePreviewRange[] {
	const activeLines = collectActiveLines(state);
	const ranges: MarkdownLivePreviewRange[] = [];

	for (const visibleRange of visibleRanges) {
		syntaxTree(state).iterate({
			from: visibleRange.from,
			to: visibleRange.to,
			enter(node) {
				const name = node.type.name;
				const headingMatch = headingPattern.exec(name);

				if (headingMatch) {
					addMark(
						ranges,
						node.from,
						node.to,
						`cm-matter-md-heading cm-matter-md-heading-${headingMatch[1]}`,
					);
				}

				if (name === 'Emphasis' || name === 'StrongEmphasis') {
					addMark(
						ranges,
						node.from,
						node.to,
						name === 'StrongEmphasis'
							? 'cm-matter-md-strong'
							: 'cm-matter-md-emphasis',
					);
				}

				if (name === 'InlineCode') {
					addMark(ranges, node.from, node.to, 'cm-matter-md-inline-code');
				}

				if (name === 'Link') {
					const label = getInlineLinkLabel(node.node);
					if (label) {
						addMark(ranges, label.from, label.to, 'cm-matter-md-link');
					}
				}

				if (name === 'ListMark' || name === 'QuoteMark') {
					addMark(ranges, node.from, node.to, 'cm-matter-md-structural-marker');
				}

				const revealScope = getRevealScope(node);
				if (revealScope && !isActiveRange(state, activeLines, revealScope)) {
					addHide(ranges, state, node.from, node.to);
				}
			},
		});
	}

	return ranges;
}

export function markdownLivePreview(): Extension {
	return [markdownLivePreviewPlugin, markdownLivePreviewTheme];
}

const markdownLivePreviewPlugin = ViewPlugin.define(
	(view) => ({
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

const hideDecoration = Decoration.replace({});

function buildDecorations(view: EditorView): DecorationSet {
	return Decoration.set(
		collectMarkdownLivePreviewRanges(view.state, view.visibleRanges).map(
			(range) => {
				if (range.type === 'hide') {
					return hideDecoration.range(range.from, range.to);
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
	range: Span,
): boolean {
	const fromLine = state.doc.lineAt(range.from).number;
	const toLine = state.doc.lineAt(range.to).number;

	for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
		if (activeLines.has(lineNumber)) return true;
	}

	return false;
}

function getRevealScope(node: SyntaxNodeRef): Span | null {
	const name = node.type.name;
	if (
		name !== 'HeaderMark' &&
		name !== 'EmphasisMark' &&
		name !== 'CodeMark' &&
		name !== 'LinkMark' &&
		name !== 'URL' &&
		name !== 'LinkTitle'
	) {
		return null;
	}

	const parent = node.node.parent;
	if (!parent) return null;

	if (name === 'HeaderMark') {
		return headingPattern.test(parent.name) ? parent : null;
	}

	if (name === 'EmphasisMark') {
		return parent.name === 'Emphasis' || parent.name === 'StrongEmphasis'
			? parent
			: null;
	}

	if (name === 'CodeMark') {
		return parent.name === 'InlineCode' ? parent : null;
	}

	return parent.name === 'Link' && getInlineLinkLabel(parent) ? parent : null;
}

function getInlineLinkLabel(link: SyntaxNode): Span | null {
	// Only inline links carry a URL child; reference and shortcut links
	// carry a LinkLabel instead.
	if (!link.getChild('URL')) return null;

	const [labelOpen, labelClose] = link.getChildren('LinkMark');
	return labelOpen && labelClose && labelOpen.to < labelClose.from
		? { from: labelOpen.to, to: labelClose.from }
		: null;
}

function addHide(
	ranges: MarkdownLivePreviewRange[],
	state: EditorState,
	from: number,
	to: number,
) {
	// CodeMirror rejects plugin-provided replace decorations that span line
	// breaks, so hidden ranges are emitted per line.
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
