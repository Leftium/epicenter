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

export {
	attachTable,
	attachTables,
	type BaseRow,
	type GetResult,
	type InferTableRow,
	type InvalidRowResult,
	type LastSchema,
	type NotFoundResult,
	type RowResult,
	type Table,
	type TableDefinition,
	type TableDefinitions,
	type Tables,
	type UpdateResult,
	type ValidRowResult,
} from './attach-table.js';

export {
	attachKv,
	type InferKvValue,
	type Kv,
	type KvChange,
	type KvDefinition,
	type KvDefinitions,
} from './attach-kv.js';

export {
	attachAwareness,
	type Awareness,
	type AwarenessDefinitions,
	type AwarenessState,
	type InferAwarenessValue,
} from './attach-awareness.js';

export type { CombinedStandardSchema } from './standard-schema.js';

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

export {
	defineDocument,
	isDocumentHandle,
	type DocumentBundle,
	type DocumentFactory,
	type DocumentHandle,
} from './define-document.js';
export { defineTable } from './define-table.js';
export { defineKv } from './define-kv.js';
export { docGuid } from './doc-guid.js';
export { type DocPersistence } from './doc-persistence.js';
export { onLocalUpdate } from './on-local-update.js';

export {
	attachEncryption,
	type EncryptionAttachment,
} from './attach-encryption.js';
export {
	EncryptionKey,
	EncryptionKeys,
	encryptionKeysFingerprint,
} from './encryption-key.js';

export { KV_KEY, TableKey, type KvKey } from './keys.js';
