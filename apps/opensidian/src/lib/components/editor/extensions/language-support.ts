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
import { markdownHighlighting } from './markdown-highlight';

type LanguageConfig = {
	language: () => LanguageSupport;
	/** Extra extensions to include when this language is active. */
	extensions?: Extension[];
};

const LANGUAGE_MAP: Record<string, LanguageConfig> = {
	'.js': { language: () => javascript() },
	'.jsx': { language: () => javascript({ jsx: true }) },
	'.ts': { language: () => javascript({ typescript: true }) },
	'.tsx': { language: () => javascript({ jsx: true, typescript: true }) },
	'.css': { language: css },
	'.html': { language: html },
	'.json': { language: json },
	'.md': {
		language: markdown,
		extensions: [markdownHighlighting],
	},
};

/**
 * Get the CodeMirror language extension and highlight style for a filename.
 *
 * Matches the file extension against known languages. Markdown files get
 * the custom `markdownHighlighting` style; all other languages use
 * CodeMirror's `defaultHighlightStyle`. Unknown extensions fall back
 * to plain markdown (since opensidian is primarily a note-taking app).
 *
 * @example
 * ```typescript
 * const extensions = getLanguageExtensions('index.ts');
 * // → [javascript({ typescript: true }), syntaxHighlighting(defaultHighlightStyle)]
 *
 * const mdExtensions = getLanguageExtensions('README.md');
 * // → [markdown(), markdownHighlighting]
 * ```
 */
export function getLanguageExtensions(filename: string): Extension[] {
	const dotIndex = filename.lastIndexOf('.');
	const ext = dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : '';
	const config = LANGUAGE_MAP[ext];

	// Unknown extension → fall back to markdown (opensidian is a note-taking app)
	if (!config) {
		return [markdown(), markdownHighlighting];
	}

	// Markdown uses its own custom highlight style
	if (ext === '.md') {
		return [config.language(), ...(config.extensions ?? [])];
	}

	// Code files use defaultHighlightStyle for syntax coloring
	return [
		config.language(),
		syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
		...(config.extensions ?? []),
	];
}
