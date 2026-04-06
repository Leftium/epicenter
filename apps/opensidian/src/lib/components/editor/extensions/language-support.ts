import { autocompletion } from '@codemirror/autocomplete';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import {
	defaultHighlightStyle,
	type LanguageSupport,
	syntaxHighlighting,
} from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { markdownHighlighting } from './markdown-highlight';

type LanguageConfig = {
	language: () => LanguageSupport;
};

const LANGUAGE_MAP: Record<string, LanguageConfig> = {
	'.js': { language: () => javascript() },
	'.jsx': { language: () => javascript({ jsx: true }) },
	'.ts': { language: () => javascript({ typescript: true }) },
	'.tsx': { language: () => javascript({ jsx: true, typescript: true }) },
	'.css': { language: css },
	'.html': { language: html },
	'.json': { language: json },
	'.md': { language: markdown },
};

function getExtension(filename: string): string {
	const dotIndex = filename.lastIndexOf('.');
	return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : '';
}

/**
 * Get the CodeMirror language and autocompletion extensions for a filename.
 *
 * Matches the file extension against known languages. Code files include
 * autocompletion; markdown files do not (wikilink autocomplete is added
 * separately via `ContentEditor`). Unknown extensions fall back to
 * markdown since opensidian is primarily a note-taking app.
 *
 * Highlight style is handled separately via {@link getHighlightStyle}
 * so it can live in a compartment for live dark/light switching.
 *
 * @example
 * ```typescript
 * const extensions = getLanguageExtensions('index.ts');
 * // → [javascript({ typescript: true }), autocompletion()]
 *
 * const mdExtensions = getLanguageExtensions('README.md');
 * // → [markdown()]
 * ```
 */
export function getLanguageExtensions(filename: string): Extension[] {
	const ext = getExtension(filename);
	const config = LANGUAGE_MAP[ext];

	if (!config) return [markdown()];
	if (ext === '.md') return [config.language()];

	return [config.language(), autocompletion()];
}

/**
 * Get the appropriate syntax highlight style for a filename and color mode.
 *
 * - Markdown files use the custom `markdownHighlighting` (CSS-var based,
 *   adapts to both light and dark themes automatically).
 * - Code files use `oneDarkHighlightStyle` in dark mode and
 *   `defaultHighlightStyle` in light mode.
 *
 * Return value is meant to live inside a `Compartment` so the editor
 * can switch highlight styles without rebuilding the entire view.
 *
 * @example
 * ```typescript
 * const highlightCompartment = new Compartment();
 * // In extensions:
 * highlightCompartment.of(getHighlightStyle('index.ts', true))
 * // On theme change:
 * view.dispatch({ effects: highlightCompartment.reconfigure(getHighlightStyle('index.ts', false)) })
 * ```
 */
export function getHighlightStyle(
	filename: string,
	isDark: boolean,
): Extension {
	const ext = getExtension(filename);

	// Markdown highlight style uses CSS custom properties—works in both modes
	if (ext === '.md' || !LANGUAGE_MAP[ext]) {
		return markdownHighlighting;
	}

	const style = isDark ? oneDarkHighlightStyle : defaultHighlightStyle;
	return syntaxHighlighting(style, { fallback: true });
}
