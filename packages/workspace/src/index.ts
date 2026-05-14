/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * This root export provides the browser-safe workspace API and shared
 * utilities.
 *
 * - `@epicenter/workspace`: browser-safe API (documents, tables, KV, sync)
 *
 * @example
 * ```typescript
 * import {
 *   attachIndexedDb,
 *   attachRichText,
 *   attachTables,
 *   createDisposableCache,
 *   createReplicaId,
 *   defineTable,
 *   docGuid,
 *   openCollaboration,
 * } from '@epicenter/workspace';
 * import { type } from 'arktype';
 * import * as Y from 'yjs';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
 * declare const openWebSocket: (
 *   url: string | URL,
 *   protocols?: string[],
 * ) => Promise<WebSocket>;
 *
 * const replicaId = createReplicaId({ storage: localStorage });
 *
 * // Singleton document + collaboration: inline at module scope, no factory wrapper.
 * const ydoc = new Y.Doc({ guid: 'notes' });
 * const tables = attachTables(ydoc, { posts });
 * const idb = attachIndexedDb(ydoc);
 * const collaboration = openCollaboration(ydoc, {
 *   url: `wss://api.example.com/workspaces/${ydoc.guid}`,
 *   waitFor: idb.whenLoaded,
 *   openWebSocket,
 *   replicaId,
 * });
 *
 * // Content docs use the same primitive with an empty action registry.
 * const noteBodyDocs = createDisposableCache(
 *   (noteId: string) => {
 *     const bodyYdoc = new Y.Doc({
 *       guid: docGuid({
 *         workspaceId: ydoc.guid,
 *         collection: 'posts',
 *         rowId: noteId,
 *         field: 'body',
 *       }),
 *       gc: false,
 *     });
 *     const bodyIdb = attachIndexedDb(bodyYdoc);
 *     const bodySync = openCollaboration(bodyYdoc, {
 *       url: `wss://api.example.com/documents/${bodyYdoc.guid}`,
 *       waitFor: bodyIdb.whenLoaded,
 *       openWebSocket,
 *       replicaId,
 *     });
 *     return {
 *       ydoc: bodyYdoc,
 *       body: attachRichText(bodyYdoc),
 *       idb: bodyIdb,
 *       sync: bodySync,
 *       [Symbol.dispose]() {
 *         bodyYdoc.destroy();
 *       },
 *     };
 *   },
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
	ActionRegistry,
} from './shared/actions';
export {
	ACTION_KEY_PATTERN,
	defineActions,
	defineMutation,
	defineQuery,
	invokeAction,
	isAction,
	toActionMeta,
} from './shared/actions';

// ════════════════════════════════════════════════════════════════════════════
// REMOTE CALLS
// ════════════════════════════════════════════════════════════════════════════

export type { EncryptionKeys } from '@epicenter/encryption';

// ════════════════════════════════════════════════════════════════════════════
// REPLICA IDENTITY
// ════════════════════════════════════════════════════════════════════════════

export {
	type AsyncStorage,
	createReplicaId,
	createReplicaIdAsync,
	type SimpleStorage,
} from './document/replica-id.js';

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
// which breaks SvelteKit/Vite SSR to client builds (see `__vite-browser-external`
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
// DOCUMENT PRIMITIVES: attach*, define*, refcounted cache, encryption,
// timeline, storage keys, types: everything in src/document/ + src/cache/
// flows through its barrel.
// ════════════════════════════════════════════════════════════════════════════

export {
	createDisposableCache,
	type DisposableCache,
	DisposableCacheError,
} from './cache/disposable-cache.js';

export {
	attachBroadcastChannel,
	attachOwnedBroadcastChannel,
	BC_ORIGIN,
} from './document/attach-broadcast-channel.js';
export {
	type AttachEncryptionOptions,
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
	type OpenWebSocket,
	type SyncError,
	SyncFailedError,
	type SyncFailedReason,
	type SyncStatus,
	SyncSupervisorError,
} from './document/internal/sync-supervisor.js';
export { websocketUrl } from './document/transport.js';
export {
	type Collaboration,
	type OpenCollaborationConfig,
	openCollaboration,
} from './document/open-collaboration.js';
export {
	attachReadonlyTable,
	attachReadonlyTables,
	attachTable,
	attachTables,
	type BaseRow,
	type InferTableRow,
	type LastSchema,
	type ReadonlyTable,
	type ReadonlyTables,
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
export {
	KV_KEY,
	type KvKey,
	PRESENCE_KEY,
	RPC_KEY,
	TableKey,
} from './document/keys.js';
export {
	type Call,
	DispatchError,
	type DispatchOptions,
	attachActionRunner,
	dispatch,
} from './document/rpc.js';
export {
	type PresenceEntry,
	type PresenceSurface,
	createPresenceSurface,
} from './document/presence.js';
export type {
	KvEntry,
	KvStoreChange,
} from './document/y-keyvalue/observable-kv-store.js';
export {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './document/y-keyvalue/y-keyvalue-lww.js';
export { onLocalUpdate } from './document/on-local-update.js';
export type { CombinedStandardSchema } from './document/standard-schema.js';
export { wipeOwnerLocalYjsData } from './document/wipe-owner-local-yjs-data.js';
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
