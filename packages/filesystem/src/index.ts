// Content helpers (document binding wrappers)
export {
	type ContentHelpers,
	createContentHelpers,
} from './content-helpers.js';
// Runtime indexes
export {
	createFileSystemIndex,
	type FileSystemIndex,
} from './file-system-index.js';

// File table definition
export { filesTable } from './file-table.js';
// File tree (metadata operations)
export { FileTree } from './file-tree.js';
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
// Path utilities
export { posixResolve } from './path-utils.js';
// Sheet helpers
export {
	parseSheetFromCsv,
	reorderColumn,
	reorderRow,
	serializeSheetToCsv,
} from './sheet-helpers.js';
export type {
	ColumnDefinition,
	ColumnId,
	FileId,
	FileRow,
	RowId,
	SheetEntry,
} from './types.js';
export { generateColumnId, generateFileId, generateRowId } from './types.js';
// Validation
export {
	assertUniqueName,
	disambiguateNames,
	fsError,
	validateName,
} from './validation.js';

// IFileSystem implementation
export { YjsFileSystem } from './yjs-file-system.js';
