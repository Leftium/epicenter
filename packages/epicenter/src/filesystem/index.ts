// Types
export type {
	ContentDocPool,
	DocumentHandle,
	FileId,
	FileRow,
	FileSystemIndex,
	RichTextDocumentHandle,
	TextDocumentHandle,
} from './types.js';
export { generateFileId } from './types.js';

// File table definition
export { filesTable } from './file-table.js';

// Validation
export {
	assertUniqueName,
	disambiguateNames,
	fsError,
	validateName,
} from './validation.js';

// Runtime indexes
export { createFileSystemIndex } from './file-system-index.js';

// Content doc pool
export {
	createContentDocPool,
	documentHandleToString,
	openDocument,
} from './content-doc-pool.js';

// Markdown helpers
export {
	markdownSchema,
	parseFrontmatter,
	serializeMarkdownWithFrontmatter,
	serializeXmlFragmentToMarkdown,
	updateYMapFromRecord,
	updateYXmlFragmentFromString,
	yMapToRecord,
} from './markdown-helpers.js';

// Convert-on-switch
export {
	convertContentType,
	getExtensionCategory,
	healContentType,
} from './convert-on-switch.js';
export type { ExtensionCategory } from './convert-on-switch.js';

// IFileSystem implementation
export { YjsFileSystem } from './yjs-file-system.js';
