/**
 * Compatibility export for the markdown materializer package path.
 *
 * The implementation lives in `document/markdown`, which is the single source
 * of truth for markdown assembly. Keep this file as a public import bridge
 * only, so behavior and tests do not fork between materializer and document
 * markdown folders.
 */
export { assembleMarkdown, type SerializeResult } from '../../markdown/markdown.js';
