/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * This root export provides the full workspace API and shared utilities.
 *
 * - `@epicenter/workspace` - Full API (documents, tables, KV, attachments)
 *
 * @example
 * ```typescript
 * import { attachTables, createDisposableCache, defineTable } from '@epicenter/workspace';
 * import { type } from 'arktype';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
 *
 * // Singleton workspace: inline at module scope, no factory wrapper.
 * const ydoc = new Y.Doc({ guid: 'notes' });
 * const tables = attachTables(ydoc, { posts });
 *
 * // Per-row docs: createDisposableCache wraps a pure builder.
 * const noteBodyDocs = createDisposableCache(
 *   (noteId) => buildNoteBody({ noteId, notesTable: tables.posts }),
 *   { gcTime: 5_000 },
 * );
 * ```
 *
 * @packageDocumentation
 */

// ════════════════════════════════════════════════════════════════════════════
// ACTION SYSTEM
// ════════════════════════════════════════════════════════════════════════════

export type {
	Action,
	ActionManifest,
	ActionMeta,
	Actions,
	Mutation,
	Query,
	RemoteActionProxy,
} from './shared/actions';
export {
	defineMutation,
	defineQuery,
	describeActions,
	invokeAction,
	invokeActionForRpc,
	isAction,
	resolveActionPath,
	walkActions,
} from './shared/actions';

// ════════════════════════════════════════════════════════════════════════════
// RPC + REMOTE ACTIONS
// ════════════════════════════════════════════════════════════════════════════

export { isRpcError, RpcError } from '@epicenter/sync';
// Cross-device action calling.
export {
	createRemoteActions,
	describeRemoteActions,
} from './rpc/remote-actions.js';
export type { InferSyncRpcMap, RpcActionMap } from './rpc/types';
export type { RemoteCallOptions } from './shared/actions.js';

// ════════════════════════════════════════════════════════════════════════════
// DEVICE IDENTITY
// ════════════════════════════════════════════════════════════════════════════

export {
	type AsyncStorage,
	getOrCreateDeviceId,
	getOrCreateDeviceIdAsync,
	type SimpleStorage,
} from './shared/device-id.js';

// ════════════════════════════════════════════════════════════════════════════
// SHARED TYPES
// ════════════════════════════════════════════════════════════════════════════

export type { MaybePromise } from './shared/types';

// ════════════════════════════════════════════════════════════════════════════
// ERROR TYPES
// ════════════════════════════════════════════════════════════════════════════

export { ExtensionError } from './shared/errors';

// JSONL file sink (Bun-only) lives at the `@epicenter/workspace/logger/jsonl-sink`
// subpath. Keeping it out of this barrel matters: re-exporting it pulls
// `node:fs`/`node:path` into every browser bundle that touches `@epicenter/workspace`,
// which breaks SvelteKit/Vite ssr→client builds (see `__vite-browser-external`
// "mkdirSync is not exported" errors). Import the sink directly from the subpath
// in Bun/Node entry points; the logger core (`createLogger`, `consoleSink`, etc.)
// still comes from `wellcrafted/logger`.

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
// DOCUMENT PRIMITIVES — attach*, define*, createDisposableCache, encryption,
// timeline, storage keys, types — everything in src/document/ + src/cache/
// flows through its barrel.
// ════════════════════════════════════════════════════════════════════════════

export {
	createDisposableCache,
	type DisposableCache,
	DisposableCacheError,
} from './cache/disposable-cache.js';
export {
	type Awareness,
	type AwarenessDefinitions,
	type AwarenessState,
	attachAwareness,
	type InferAwarenessValue,
} from './document/attach-awareness.js';

export {
	attachBroadcastChannel,
	BC_ORIGIN,
	type BroadcastChannelAttachment,
} from './document/attach-broadcast-channel.js';
export {
	attachEncryption,
	type EncryptionAttachment,
} from './document/attach-encryption.js';
export {
	attachIndexedDb,
	type IndexedDbAttachment,
} from './document/attach-indexed-db.js';
export {
	attachKv,
	type InferKvValue,
	type Kv,
	type KvChange,
	type KvDefinition,
	type KvDefinitions,
} from './document/attach-kv.js';
export {
	attachPlainText,
	type PlainTextAttachment,
} from './document/attach-plain-text.js';
export {
	attachRichText,
	type RichTextAttachment,
	xmlFragmentToPlaintext,
} from './document/attach-rich-text.js';
export {
	attachSqlite,
	type SqliteAttachment,
} from './document/attach-sqlite.js';
export {
	type AttachSyncDoc,
	attachSync,
	type SyncAttachment,
	type SyncAttachmentConfig,
	SyncFailedError,
	type SyncFailedReason,
	type SyncStatus,
	toWsUrl,
	type WaitForBarrier,
} from './document/attach-sync.js';
export {
	attachTable,
	attachTables,
	type BaseRow,
	type InferTableRow,
	type LastSchema,
	type Table,
	type TableDefinition,
	type TableDefinitions,
	TableParseError,
	type Tables,
} from './document/attach-table.js';

export {
	attachTimeline,
	type ContentType,
	computeMidpoint,
	generateInitialOrders,
	parseSheetFromCsv,
	populateFragmentFromText,
	type RichTextEntry,
	type SheetBinding,
	type SheetEntry,
	serializeSheetToCsv,
	type TextEntry,
	type Timeline,
	type TimelineEntry,
} from './document/attach-timeline/index.js';
export { defineKv } from './document/define-kv.js';
export { defineTable } from './document/define-table.js';
export { docGuid } from './document/doc-guid.js';
export type { DocPersistence } from './document/doc-persistence.js';
export {
	EncryptionKey,
	EncryptionKeys,
	encryptionKeysFingerprint,
} from './document/encryption-key.js';
export { KV_KEY, type KvKey, TableKey } from './document/keys.js';
export { onLocalUpdate } from './document/on-local-update.js';
export {
	type DeviceDescriptor,
	type FoundPeer,
	type PeerAwarenessState,
	PeerDevice,
	Platform,
} from './document/standard-awareness-defs.js';
export type { CombinedStandardSchema } from './document/standard-schema.js';
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
