import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from '@codemirror/view';
import type { FileId } from '@epicenter/filesystem';
import { getTargetFileId, isInternalLink } from '@epicenter/filesystem';

/**
 * Configuration for the link decoration plugin.
 *
 * @example
 * ```typescript
 * linkDecorations({
 *   onNavigate: (fileId) => fsState.selectFile(fileId),
 *   resolveTitle: (fileId) => fsState.getFile(fileId)?.name ?? null,
 * })
 * ```
 */
type LinkDecorationConfig = {
	/** Called when a decorated link is clicked. */
	onNavigate: (fileId: FileId) => void;
	/**
	 * Optional title resolver. When provided and returns non-null,
	 * the widget displays the resolved title instead of the stored display text.
	 * Useful for live-rendering renamed pages.
	 */
	resolveTitle?: (fileId: FileId) => string | null;
};

/** Regex matching `[display text](id:GUID)` in document text. */
const INTERNAL_LINK_RE = /\[([^\]]+)\]\((id:[^)]+)\)/g;

/**
 * Widget that renders an internal link as a clickable styled span.
 *
 * Replaces the full `[text](id:GUID)` match in the document with a
 * compact, styled span showing just the display text (or resolved title).
 */
class InternalLinkWidget extends WidgetType {
	constructor(
		private readonly displayText: string,
		private readonly fileId: FileId,
		private readonly config: LinkDecorationConfig,
	) {
		super();
	}

	override toDOM(): HTMLElement {
		const span = document.createElement('span');
		const resolvedTitle = this.config.resolveTitle?.(this.fileId);
		span.textContent = resolvedTitle ?? this.displayText;
		span.className = 'cm-internal-link';
		span.style.cssText =
			'text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); text-underline-offset: 2px; cursor: pointer; color: var(--primary, #3b82f6);';
		span.title = resolvedTitle ?? this.displayText;

		span.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.config.onNavigate(this.fileId);
		});

		return span;
	}

	override eq(other: InternalLinkWidget): boolean {
		return (
			this.fileId === other.fileId && this.displayText === other.displayText
		);
	}

	override ignoreEvent(): boolean {
		return false;
	}
}

/**
 * Check whether a position falls inside a code block or inline code span.
 *
 * Uses the CodeMirror syntax tree to detect `FencedCode`, `InlineCode`,
 * and `CodeBlock` node types.
 */
function isInsideCode(view: EditorView, pos: number): boolean {
	let isCode = false;
	syntaxTree(view.state).iterate({
		from: pos,
		to: pos,
		enter(node) {
			const name = node.type.name;
			if (
				name === 'FencedCode' ||
				name === 'InlineCode' ||
				name === 'CodeBlock'
			) {
				isCode = true;
				return false;
			}
		},
	});
	return isCode;
}

/**
 * Build decorations for all visible internal links in the editor.
 *
 * Scans visible ranges for `[text](id:GUID)` patterns, skipping matches
 * inside code blocks, and creates `Decoration.replace` widgets for each.
 */
function buildDecorations(
	view: EditorView,
	config: LinkDecorationConfig,
): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();

	for (const { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		let match: RegExpExecArray | null;
		INTERNAL_LINK_RE.lastIndex = 0;

		while (true) {
			match = INTERNAL_LINK_RE.exec(text);
			if (match === null) {
				break;
			}

			const start = from + match.index;
			const end = start + match[0].length;
			const displayText = match[1];
			const href = match[2];

			if (displayText === undefined || href === undefined) {
				continue;
			}

			if (!isInternalLink(href)) continue;
			if (isInsideCode(view, start)) continue;

			const fileId = getTargetFileId(href);
			const widget = new InternalLinkWidget(displayText, fileId, config);

			builder.add(start, end, Decoration.replace({ widget }));
		}
	}

	return builder.finish();
}

/**
 * Create a CodeMirror extension that decorates internal `id:` links
 * as clickable styled spans.
 *
 * Scans visible document ranges for `[display text](id:GUID)` patterns,
 * skips matches inside fenced code blocks and inline code, and replaces
 * each match with a styled widget showing just the display text.
 *
 * @example
 * ```typescript
 * import { linkDecorations } from './extensions/link-decorations';
 *
 * const extensions = [
 *   linkDecorations({
 *     onNavigate: (fileId) => fsState.selectFile(fileId),
 *     resolveTitle: (fileId) => fsState.getFile(fileId)?.name ?? null,
 *   }),
 * ];
 * ```
 */
export function linkDecorations(config: LinkDecorationConfig) {
	return ViewPlugin.define(
		(view): PluginValue & { decorations: DecorationSet } => ({
			decorations: buildDecorations(view, config),
			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = buildDecorations(update.view, config);
				}
			},
		}),
		{
			decorations: (plugin) => plugin.decorations,
		},
	);
}
