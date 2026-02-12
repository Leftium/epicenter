// Types

// Content doc store
export { createContentDocStore } from './content-doc-store.js';
// Runtime indexes
export { createFileSystemIndex } from './file-system-index.js';

// File table definition
export { filesTable } from './file-table.js';
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
export type {
	ContentDocStore,
	FileId,
	FileRow,
	FileSystemIndex,
} from './types.js';
export { generateFileId } from './types.js';
// Validation
export {
	assertUniqueName,
	disambiguateNames,
	fsError,
	validateName,
} from './validation.js';

// IFileSystem implementation
export { YjsFileSystem } from './yjs-file-system.js';
