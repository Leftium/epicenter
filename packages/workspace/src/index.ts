/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * `@epicenter/workspace` attaches typed primitives: tables, KV, plain/rich
 * text, timeline, and an action registry to a `Y.Doc`, then wires the
 * result to IndexedDB persistence and WebSocket sync via
 * `openCollaboration`. `openCollaboration` also consumes the
 * server-owned presence channel and exposes the live-device surface
 * (`devices.list()`) plus socket-backed `dispatch()` for cross-device calls.
 *
 * @example
 * ```typescript
 * import {
 *   attachRichText,
 *   type ConnectionConfig,
 *   defineTable,
 *   defineWorkspace,
 * } from '@epicenter/workspace';
 * import { field } from '@epicenter/field';
 *
 * const posts = defineTable({
 *   id: field.string(),
 *   title: field.string(),
 * }).childDocs({ body: attachRichText });
 *
 * const notesWorkspace = defineWorkspace({
 *   id: 'notes',
 *   tables: { posts },
 *   kv: {},
 * });
 *
 * declare const connection: ConnectionConfig;
 * using workspace = notesWorkspace.open(connection);
 * using body = workspace.tables.posts.docs.body.open('post-1');
 * await body.whenLoaded;
 * ```
 *
 * @packageDocumentation
 */

// ════════════════════════════════════════════════════════════════════════════
// ACTION SYSTEM
// ════════════════════════════════════════════════════════════════════════════

export type { ActionManifest, ActionRegistry } from './shared/actions';
export {
	defineActions,
	defineMutation,
	defineQuery,
} from './shared/actions';

// ════════════════════════════════════════════════════════════════════════════
// DEVICE IDENTITY
// ════════════════════════════════════════════════════════════════════════════

export type { DeviceId } from './document/device-id.js';
export {
	asDeviceId,
	createDeviceId,
	createDeviceIdAsync,
} from './document/device-id.js';

// ════════════════════════════════════════════════════════════════════════════
// EPICENTER CONFIG (browser-safe surface)
// ════════════════════════════════════════════════════════════════════════════

// Node-only helpers that resolve real paths (`findEpicenterRoot`,
// `openEpicenterRoot`, etc.) import `node:fs`, `node:path`, or `node:os`
// at module top level. They are exported from `@epicenter/workspace/node`;
// keeping them out of this root barrel stops browser bundles (fuji,
// whispering, etc.) from traversing `node:*` modules. Daemon runtime and
// log paths live in `@epicenter/workspace/daemon/paths.ts`.
export { DEFAULT_EPICENTER_CONFIG_SOURCE } from './config/epicenter-config-source.js';
export { defineMount } from './daemon/define-mount.js';
export type { EpicenterRoot } from './shared/types';

// ════════════════════════════════════════════════════════════════════════════
// ID + DATE PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════

export { CalendarDateString, DateTimeString } from '@epicenter/field';
export { IanaTimeZone } from './shared/iana-time-zone';
export type { Guid, Id } from './shared/id';
export { generateGuid, generateId } from './shared/id';

// ════════════════════════════════════════════════════════════════════════════
// EMPTINESS AXIS (nullable: substrate value policy)
// ════════════════════════════════════════════════════════════════════════════

export { nullable } from './document/nullable';

// ════════════════════════════════════════════════════════════════════════════
// TIMING
// ════════════════════════════════════════════════════════════════════════════

export { debounce } from './shared/debounce.js';

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════

export {
	createDisposableCache,
	type DisposableCache,
} from './cache/disposable-cache.js';
export { attachBroadcastChannel } from './document/attach-broadcast-channel.js';
export { attachIndexedDb } from './document/attach-indexed-db.js';
export { attachLocalStorage } from './document/attach-local-storage.js';
export { attachPlainText } from './document/attach-plain-text.js';
export { attachRichText } from './document/attach-rich-text.js';
export { attachTimeline } from './document/attach-timeline/index.js';
export { type ConnectionConfig, connectDoc } from './document/connect-doc.js';
export { createChildDocs } from './document/create-child-docs.js';
export { defineKv } from './document/define-kv.js';
export { defineTable } from './document/define-table.js';
export {
	DispatchError,
	type DispatchRequest,
} from './document/dispatch.js';
export { docGuid } from './document/doc-guid.js';
// One-shot HTTP read of a hosted room: GET the snapshot into a throwaway doc.
// The atomic snapshot lets a relay-only doc be read without a live
// `openCollaboration` session.
export { readRoomOverHttp } from './document/http-room-sync.js';
export type { SyncStatus } from './document/internal/sync-supervisor.js';
export type {
	InferKvValue,
	Kv,
	KvDefinitions,
} from './document/kv.js';
export { onLocalUpdate } from './document/on-local-update.js';
export {
	type Collaboration,
	type OnReconnectSignal,
	type OpenCollaborationConfig,
	type OpenWebSocketFn,
	openCollaboration,
} from './document/open-collaboration.js';
export type { PresenceDevice } from './document/presence-protocol.js';
export {
	type BaseRow,
	type InferTableRow,
	type ReadonlyTable,
	type Table,
	TableNewerWriterError,
	TableParseError,
	type TableReadError,
	type TableScan,
	type Tables,
	TableWriteError,
} from './document/table.js';
// Transport URL builder.
//
// `roomWsUrl({ baseURL, ownerId, guid, deviceId })` builds the WebSocket
// URL for the partitioned `/api/owners/:ownerId/rooms/:roomId` endpoint. The
// same single URL form is used in both personal and shared modes. Both browser
// apps and the daemon use this one builder.
export { type RoomWsUrlOptions, roomWsUrl } from './document/transport.js';
export { wipeLocalStorage } from './document/wipe-local-storage.js';
export {
	type ConnectedTables,
	type ConnectedWorkspace,
	type ConnectedWorkspaceContext,
	type CreateWorkspaceOptions,
	createWorkspace,
	type DefineWorkspaceOptions,
	defineWorkspace,
	satisfiesWorkspace,
	type Workspace,
	type WorkspaceActionContext,
	type WorkspaceDefinition,
	type WorkspaceFromDefinition,
	type WorkspaceRuntimeExtension,
	type WorkspaceTables,
} from './document/workspace.js';
