/**
 * Compatibility export for the markdown materializer package path.
 *
 * Markdown file preparation has one implementation in `document/markdown`.
 * This bridge keeps the materializer API stable while the shared tests cover
 * the only behavior source.
 */
export { prepareMarkdownFiles } from '../../markdown/prepare-markdown-files.js';
