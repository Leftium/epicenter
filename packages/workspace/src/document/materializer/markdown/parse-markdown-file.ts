/**
 * Compatibility export for the markdown materializer package path.
 *
 * Frontmatter parsing is owned by `document/markdown`. Re-exporting it here
 * keeps existing materializer imports working without copying parser behavior
 * or duplicating parser tests.
 */
export { parseMarkdownFile } from '../../markdown/parse-markdown-file.js';
