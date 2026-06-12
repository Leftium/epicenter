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

/**
 * Node name to mark class. The whole node is styled, markers included;
 * hiding markers on inactive lines is handled separately, so on active lines
 * the markers render in their construct's look. List and quote markers are
 * styled here but never hidden. Node names absent from this table
 * (SetextHeading, FencedCode, Image, Autolink, tables, HTML) render plain.
 */
const markClassByNode: Record<string, string> = {
	ATXHeading1: 'cm-matter-md-heading cm-matter-md-heading-1',
	ATXHeading2: 'cm-matter-md-heading cm-matter-md-heading-2',
	ATXHeading3: 'cm-matter-md-heading cm-matter-md-heading-3',
	ATXHeading4: 'cm-matter-md-heading cm-matter-md-heading-4',
	ATXHeading5: 'cm-matter-md-heading cm-matter-md-heading-5',
	ATXHeading6: 'cm-matter-md-heading cm-matter-md-heading-6',
	StrongEmphasis: 'cm-matter-md-strong',
	Emphasis: 'cm-matter-md-emphasis',
	InlineCode: 'cm-matter-md-inline-code',
	ListMark: 'cm-matter-md-structural-marker',
	QuoteMark: 'cm-matter-md-structural-marker',
};

/**
 * Marker node name to the construct parents that own its reveal. A marker is
 * hidden only when its direct parent is listed here and no selection range
 * touches the parent's lines. Markers with unlisted parents always stay raw,
 * which keeps setext underlines (HeaderMark under SetextHeading), fenced-code
 * backticks (CodeMark under FencedCode), and image, reference-link, and
 * autolink punctuation visible.
 *
 * Hidden ranges must never span a line break: CodeMirror rejects replace
 * decorations that cross lines when they come from a view plugin. Every
 * marker here is single-line by the CommonMark grammar except LinkTitle,
 * which getRevealScope covers by leaving multi-line links raw.
 */
const revealParentsByMarker: Record<string, readonly string[]> = {
	HeaderMark: [
		'ATXHeading1',
		'ATXHeading2',
		'ATXHeading3',
		'ATXHeading4',
		'ATXHeading5',
		'ATXHeading6',
	],
	EmphasisMark: ['Emphasis', 'StrongEmphasis'],
	CodeMark: ['InlineCode'],
	LinkMark: ['Link'],
	URL: ['Link'],
	LinkTitle: ['Link'],
};

/**
 * Compute the live-preview spans for the visible ranges. Pure with respect to
 * the editor state: it reads the syntax tree and the selection and returns
 * plain spans, which is the surface the tests assert on.
 *
 * A line is active when any selection range overlaps it. Markers whose
 * construct touches an active line stay raw; style marks apply everywhere.
 */
export function collectMarkdownLivePreviewRanges(
	state: EditorState,
	visibleRanges: readonly Span[],
): MarkdownLivePreviewRange[] {
	const activeSpans = state.selection.ranges.map((range) => ({
		from: state.doc.lineAt(range.from).from,
		to: state.doc.lineAt(range.to).to,
	}));
	const isRevealed = (span: Span) =>
		activeSpans.some(
			(active) => active.from <= span.to && span.from <= active.to,
		);

	const ranges: MarkdownLivePreviewRange[] = [];

	for (const visibleRange of visibleRanges) {
		syntaxTree(state).iterate({
			from: visibleRange.from,
			to: visibleRange.to,
			enter(node) {
				const name = node.type.name;

				const className = markClassByNode[name];
				if (className) {
					ranges.push({
						type: 'mark',
						from: node.from,
						to: node.to,
						className,
					});
				}

				if (name === 'Link') {
					const label = getInlineLinkLabel(node.node);
					if (label) {
						ranges.push({
							type: 'mark',
							from: label.from,
							to: label.to,
							className: 'cm-matter-md-link',
						});
					}
				}

				const revealScope = getRevealScope(node, state);
				if (revealScope && !isRevealed(revealScope)) {
					ranges.push({ type: 'hide', from: node.from, to: node.to });
				}
			},
		});
	}

	return ranges;
}

/**
 * Live Markdown preview as pure view behavior: inactive lines hide marker
 * punctuation and style constructs, and lines touched by any selection show
 * raw Markdown. The extension never dispatches document changes.
 */
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
				// Background parsing dispatches updates as the tree grows; a
				// changed tree identity means new nodes may need decorating.
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
			(range) =>
				range.type === 'hide'
					? hideDecoration.range(range.from, range.to)
					: Decoration.mark({ class: range.className }).range(
							range.from,
							range.to,
						),
		),
		true,
	);
}

/**
 * The construct whose lines decide whether this marker is revealed, or null
 * when the marker always stays raw. Markers are direct children of their
 * construct in the lezer Markdown tree, so one parent check suffices.
 */
function getRevealScope(node: SyntaxNodeRef, state: EditorState): Span | null {
	const parents = revealParentsByMarker[node.type.name];
	if (!parents) return null;

	const parent = node.node.parent;
	if (!parent || !parents.includes(parent.name)) return null;

	if (parent.name === 'Link') {
		// Links are previewed only when their syntax sits on one line; a
		// multi-line LinkTitle could otherwise produce a hidden range that
		// spans a line break, and half-hiding a wrapped link reads worse
		// than showing it raw.
		if (state.doc.lineAt(parent.from).to < parent.to) return null;
		if (!getInlineLinkLabel(parent)) return null;
	}

	return parent;
}

/**
 * The label span of an inline link, or null for anything that should stay
 * raw: reference and shortcut links (they carry a LinkLabel instead of a URL
 * child) and empty labels like [](url), which would otherwise preview as
 * nothing at all.
 */
function getInlineLinkLabel(link: SyntaxNode): Span | null {
	if (!link.getChild('URL')) return null;

	const [labelOpen, labelClose] = link.getChildren('LinkMark');
	return labelOpen && labelClose && labelOpen.to < labelClose.from
		? { from: labelOpen.to, to: labelClose.from }
		: null;
}
