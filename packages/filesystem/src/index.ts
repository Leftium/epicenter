// Types

// Content doc store (deprecated — Phase 3 will remove)
export { createContentDocStore } from './content-doc-store.js';
// Content I/O operations (deprecated — Phase 3 will remove)
export { ContentOps } from './content-ops.js';
// Content helpers (document binding wrappers)
export { createContentHelpers, type ContentHelpers } from './content-helpers.js';
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
	ContentDocStore,
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
