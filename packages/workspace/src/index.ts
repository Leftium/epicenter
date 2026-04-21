/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * This root export provides the full workspace API and shared utilities.
 *
 * - `@epicenter/workspace` - Full API (documents, tables, KV, attachments)
 *
 * @example
 * ```typescript
 * import { defineDocument, defineTable, attachTables } from '@epicenter/workspace';
 * import { type } from 'arktype';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
 * const notesDoc = defineDocument('notes', () => {
 *   const ydoc = new Y.Doc({ guid: 'notes' });
 *   const tables = attachTables(ydoc, { posts });
 *   return { id: 'notes', ydoc, tables };
 * });
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
// SHARED TYPES
// ════════════════════════════════════════════════════════════════════════════

export type { MaybePromise } from './shared/types';

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
// DOCUMENT PRIMITIVES — attach*, defineDocument, timeline, storage keys, types
// ════════════════════════════════════════════════════════════════════════════

export * from './document/index.js';

// ════════════════════════════════════════════════════════════════════════════
// SCHEMA DEFINITIONS (Pure)
// ════════════════════════════════════════════════════════════════════════════

export { defineKv } from './document/define-kv';
export { defineTable } from './document/define-table';
export {
	attachEncryption,
	type EncryptionAttachment,
} from './document/attach-encryption';
export {
	attachEncryptedKv,
	attachEncryptedTable,
	attachEncryptedTables,
} from './document/attach-encrypted';

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

// Runtime schemas (arktype) — for validation at deserialization boundaries
export {
	EncryptionKey,
	EncryptionKeys,
	encryptionKeysFingerprint,
} from './document/encryption-key';
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
