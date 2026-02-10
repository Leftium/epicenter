// Types
export type {
	ContentDocPool,
	DocumentHandle,
	FileRow,
	FileSystemIndex,
	RichTextDocumentHandle,
	TextDocumentHandle,
} from './types.js';
export { ROOT_ID } from './types.js';

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
