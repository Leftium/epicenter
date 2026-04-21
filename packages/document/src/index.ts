export {
	attachIndexedDb,
	type IndexedDbAttachment,
} from './attach-indexed-db.js';

export {
	attachSqlite,
	type SqliteAttachment,
} from './attach-sqlite.js';

export {
	attachBroadcastChannel,
	BC_ORIGIN,
	type BroadcastChannelAttachment,
} from './attach-broadcast-channel.js';

export {
	attachRichText,
	xmlFragmentToPlaintext,
	type RichTextAttachment,
} from './attach-rich-text.js';

export {
	attachPlainText,
	type PlainTextAttachment,
} from './attach-plain-text.js';

export {
	attachSync,
	toWsUrl,
	type DefaultRpcMap,
	type RpcActionMap,
	type RpcConfig,
	type RpcDispatch,
	type SyncAttachment,
	type SyncAttachmentConfig,
	type SyncStatus,
} from './attach-sync.js';

export { attachTable, attachTables } from './attach-table.js';
export { attachKv } from './attach-kv.js';
export { attachAwareness } from './attach-awareness.js';

export {
	attachTimeline,
	computeMidpoint,
	generateInitialOrders,
	parseSheetFromCsv,
	populateFragmentFromText,
	serializeSheetToCsv,
	type ContentType,
	type RichTextEntry,
	type SheetBinding,
	type SheetEntry,
	type TextEntry,
	type Timeline,
	type TimelineEntry,
} from './attach-timeline/index.js';

export { defineDocument } from './define-document.js';
export { docGuid } from './doc-guid.js';
export type {
	DocumentFactory,
	DocumentHandle,
} from './define-document.types.js';
export { NO_PERSISTENCE, type DocPersistence } from './doc-persistence.js';
export { buildPerRowDoc, type PerRowDocBase } from './build-per-row-doc.js';
export { DOCUMENTS_ORIGIN, onLocalUpdate } from './on-local-update.js';

export { KV_KEY, TableKey, type KvKey } from './keys.js';

export type {
	Awareness,
	AwarenessDefinitions,
	AwarenessState,
	BaseRow,
	CombinedStandardSchema,
	ContentHandle,
	ContentStrategy,
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
