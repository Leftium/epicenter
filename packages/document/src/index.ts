export {
	defineDocument,
	openDocument,
	type DocumentDefinition,
	type DocumentHandle,
} from './define-document.js';

export {
	attachIndexedDb,
	type IndexedDbAttachment,
} from './attach-indexed-db.js';

export {
	attachRichText,
	type RichTextAttachment,
} from './attach-rich-text.js';

export {
	attachPlainText,
	type PlainTextAttachment,
} from './attach-plain-text.js';

export {
	attachSync,
	toWsUrl,
	type SyncAttachment,
	type SyncAttachmentConfig,
	type SyncStatus,
} from './attach-sync.js';

export { attachTable } from './attach-table.js';
export { attachKv } from './attach-kv.js';
export { attachAwareness } from './attach-awareness.js';

export type {
	AwarenessDefinitions,
	AwarenessHelper,
	AwarenessState,
	BaseRow,
	CombinedStandardSchema,
	GetResult,
	InferAwarenessValue,
	InferKvValue,
	InferTableRow,
	InvalidRowResult,
	KvChange,
	KvDefinition,
	KvDefinitions,
	KvHelper,
	LastSchema,
	NotFoundResult,
	RowResult,
	TableDefinition,
	TableDefinitions,
	TableHelper,
	TablesHelper,
	UpdateResult,
	ValidRowResult,
} from './types.js';
