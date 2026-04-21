/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * This root export provides the full workspace API and shared utilities.
 *
 * - `@epicenter/workspace` - Full API (workspace creation, tables, KV, extensions)
 * - `@epicenter/workspace/extensions` - Extension plugins (persistence, sync)
 *
 * @example
 * ```typescript
 * import { createWorkspace, defineTable } from '@epicenter/workspace';
 * import { type } from 'arktype';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
 * const client = createWorkspace({ id: 'my-app', tables: { posts } });
 * ```
 *
 * @packageDocumentation
 */

// ════════════════════════════════════════════════════════════════════════════
// ACTION SYSTEM
// ════════════════════════════════════════════════════════════════════════════

export type { Action, Actions, Mutation, Query } from './shared/actions';
export {
	ACTION_BRAND,
	defineMutation,
	defineQuery,
	dispatchAction,
	isAction,
	isMutation,
	isQuery,
	iterateActions,
} from './shared/actions';

// ════════════════════════════════════════════════════════════════════════════
// RPC
// ════════════════════════════════════════════════════════════════════════════

export type { InferRpcMap, RpcActionMap } from './rpc/types';

// ════════════════════════════════════════════════════════════════════════════
// LIFECYCLE PROTOCOL
// ════════════════════════════════════════════════════════════════════════════

export type { MaybePromise, RawExtension } from './workspace/lifecycle';

// ════════════════════════════════════════════════════════════════════════════
// ERROR TYPES
// ════════════════════════════════════════════════════════════════════════════

export { ExtensionError } from './shared/errors';

// ════════════════════════════════════════════════════════════════════════════
// CORE TYPES
// ════════════════════════════════════════════════════════════════════════════

export type { AbsolutePath, ProjectDir } from './shared/types';

// ════════════════════════════════════════════════════════════════════════════
// ID UTILITIES
// ════════════════════════════════════════════════════════════════════════════

export type { Guid, Id } from './shared/id';
export { generateGuid, generateId, Id as createId } from './shared/id';

// ════════════════════════════════════════════════════════════════════════════
// DATE UTILITIES
// ════════════════════════════════════════════════════════════════════════════

export type {
	DateIsoString,
	ParsedDateTimeString,
	TimezoneId,
} from './shared/datetime-string';
export { DateTimeString } from './shared/datetime-string';

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT PRIMITIVES (plaintext Y.Doc composition)
// ════════════════════════════════════════════════════════════════════════════

export {
	attachIndexedDb,
	type IndexedDbAttachment,
} from './document/index.js';
export { attachSqlite, type SqliteAttachment } from './document/index.js';
export {
	attachBroadcastChannel,
	BC_ORIGIN,
	type BroadcastChannelAttachment,
} from './document/index.js';
export {
	attachRichText,
	xmlFragmentToPlaintext,
	type RichTextAttachment,
} from './document/index.js';
export {
	attachPlainText,
	type PlainTextAttachment,
} from './document/index.js';
export {
	attachSync,
	toWsUrl,
	type DefaultRpcMap,
	type RpcConfig,
	type RpcDispatch,
	type SyncAttachment,
	type SyncAttachmentConfig,
	type SyncStatus,
} from './document/index.js';
export { attachTable, attachTables, type LastSchema } from './document/index.js';
export { attachKv } from './document/index.js';
export { attachAwareness } from './document/index.js';
export type { CombinedStandardSchema } from './document/index.js';

// ════════════════════════════════════════════════════════════════════════════
// TIMELINE
// ════════════════════════════════════════════════════════════════════════════

export type {
	ContentType,
	RichTextEntry,
	SheetBinding,
	SheetEntry,
	TextEntry,
	TimelineEntry,
} from './document/index.js';
export {
	attachTimeline,
	computeMidpoint,
	generateInitialOrders,
	parseSheetFromCsv,
	populateFragmentFromText,
	serializeSheetToCsv,
	type Timeline,
} from './document/index.js';

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT FACTORY
// ════════════════════════════════════════════════════════════════════════════

export {
	defineDocument,
	type DocumentFactory,
	type DocumentHandle,
} from './document/index.js';
export { docGuid } from './document/index.js';
export { createPerRowDoc, type DocPersistence } from './document/index.js';
export { DOCUMENTS_ORIGIN, onLocalUpdate } from './document/index.js';

// ════════════════════════════════════════════════════════════════════════════
// Y.DOC STORAGE KEYS
// ════════════════════════════════════════════════════════════════════════════

export type { KvKey, TableKey as TableKeyType } from './document/index.js';
export { KV_KEY, TableKey } from './document/index.js';

// ════════════════════════════════════════════════════════════════════════════
// SCHEMA DEFINITIONS (Pure)
// ════════════════════════════════════════════════════════════════════════════

export { defineKv } from './workspace/define-kv';
export { defineTable } from './workspace/define-table';
export {
	attachEncryption,
	type EncryptionAttachment,
} from './workspace/attach-encryption';
export {
	attachEncryptedKv,
	attachEncryptedTable,
	attachEncryptedTables,
} from './workspace/attach-encrypted';

// ════════════════════════════════════════════════════════════════════════════
// WORKSPACE CREATION
// ════════════════════════════════════════════════════════════════════════════

export { createWorkspace } from './workspace/create-workspace';

// ════════════════════════════════════════════════════════════════════════════
// INTROSPECTION
// ════════════════════════════════════════════════════════════════════════════

export type {
	ActionDescriptor,
	SchemaDescriptor,
	WorkspaceDescriptor,
} from './workspace/describe-workspace';
export { describeWorkspace } from './workspace/describe-workspace';

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

// Runtime schemas (arktype) — for validation at deserialization boundaries
export {
	EncryptionKey,
	EncryptionKeys,
	encryptionKeysFingerprint,
} from './workspace/encryption-key';
export type {
	Awareness,
	AwarenessDefinitions,
	AwarenessState,
	BaseRow,
	GetResult,
	InferAwarenessValue,
	InferKvValue,
	InferTableRow,
	InvalidRowResult,
	Kv,
	KvChange,
	KvDefinition,
	KvDefinitions,
	NotFoundResult,
	RowResult,
	Table,
	TableDefinition,
	TableDefinitions,
	Tables,
	UpdateResult,
	ValidRowResult,
} from './document/index.js';
export type {
	AnyWorkspaceClient,
	ExtensionContext,
	SharedExtensionContext,
	WorkspaceClient,
	WorkspaceClientBuilder,
	WorkspaceDefinition,
} from './workspace/create-workspace';

// ════════════════════════════════════════════════════════════════════════════
// EPICENTER LINKS
// ════════════════════════════════════════════════════════════════════════════

export {
	convertEpicenterLinksToWikilinks,
	convertWikilinksToEpicenterLinks,
	EPICENTER_LINK_RE,
	type EpicenterLink,
	isEpicenterLink,
	makeEpicenterLink,
	parseEpicenterLink,
} from './links.js';
