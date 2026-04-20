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

export { KV_KEY, TableKey, type KvKey } from './keys.js';

export type {
	Awareness,
	AwarenessDefinitions,
	AwarenessState,
	BaseRow,
	CombinedStandardSchema,
	GetResult,
	InferAwarenessValue,
	InferKvValue,
	InferTableRow,
	InvalidRowResult,
	Kv,
	KvChange,
	KvDefinition,
	KvDefinitions,
	LastSchema,
	NotFoundResult,
	RowResult,
	Table,
	TableDefinition,
	TableDefinitions,
	Tables,
	UpdateResult,
	ValidRowResult,
} from './types.js';
