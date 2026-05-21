/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * `@epicenter/workspace` attaches typed primitives: tables, KV, plain/rich
 * text, timeline, and an action registry to a `Y.Doc`, then wires the
 * result to IndexedDB persistence, end-to-end encryption, and WebSocket
 * sync via `openCollaboration`. `openCollaboration` also publishes
 * per-peer liveness via y-protocols awareness and exposes the live-device
 * surface (`devices.list()`) plus HTTP-backed `dispatch()` for cross-
 * device calls.
 *
 * @example
 * ```typescript
 * import {
 *   attachIndexedDb,
 *   attachRichText,
 *   attachTables,
 *   createDisposableCache,
 *   createInstallationId,
 *   defineTable,
 *   docGuid,
 *   openCloudAppSync,
 * } from '@epicenter/workspace';
 * import type { AuthClient } from '@epicenter/auth';
 * import { type } from 'arktype';
 * import * as Y from 'yjs';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
 * declare const auth: AuthClient;
 *
 * // One factory per app instance: captures auth, appId, and installationId,
 * // runs /api/workspaces once across every doc the app opens, and subscribes
 * // to auth state so sign-in transitions re-attach every live handle.
 * const notesCloud = openCloudAppSync({
 *   auth,
 *   apiUrl: 'https://api.example.com',
 *   appId: 'notes',
 *   installationId: createInstallationId({ storage: localStorage }),
 * });
 *
 * const ydoc = new Y.Doc({ guid: 'notes' });
 * const tables = attachTables(ydoc, { posts });
 * const idb = attachIndexedDb(ydoc);
 * const collaboration = notesCloud.open(ydoc, {
 *   docId: 'root',
 *   waitFor: idb.whenLoaded,
 *   actions: {},
 * });
 *
 * // Content docs use the same factory with an empty action registry. The
 * // local Y.Doc guid doubles as the cloud docId, so no second id system.
 * const noteBodyDocs = createDisposableCache(
 *   (noteId: string) => {
 *     const bodyYdoc = new Y.Doc({
 *       guid: docGuid({
 *         workspaceId: ydoc.guid,
 *         collection: 'posts',
 *         rowId: noteId,
 *         field: 'body',
 *       }),
 *       gc: true,
 *     });
 *     const bodyIdb = attachIndexedDb(bodyYdoc);
 *     const bodySync = notesCloud.open(bodyYdoc, {
 *       waitFor: bodyIdb.whenLoaded,
 *       actions: {},
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

export type { Action, ActionManifest } from './shared/actions';
export {
	defineActions,
	defineMutation,
	defineQuery,
} from './shared/actions';

// ════════════════════════════════════════════════════════════════════════════
// INSTALLATION IDENTITY
// ════════════════════════════════════════════════════════════════════════════

export {
	createInstallationId,
	createInstallationIdAsync,
} from './document/installation-id.js';

// ════════════════════════════════════════════════════════════════════════════
// PATH TYPES (for daemon callers)
// ════════════════════════════════════════════════════════════════════════════

export { findProjectRoot } from './client/find-project-root.js';
export {
	DEFAULT_PROJECT_CONFIG_SOURCE,
	defineConfig,
	type EpicenterConfig,
	PROJECT_CONFIG_FILENAME,
} from './config/define-config.js';
export {
	loadProjectConfig,
	ProjectConfigError,
	type ProjectConfigError as ProjectConfigErrorType,
} from './config/load-project-config.js';
export {
	userCacheDir,
	userConfigDir,
	userDataDir,
	userLogDir,
} from './paths/user-paths.js';
export type { ProjectDir } from './shared/types';

// ════════════════════════════════════════════════════════════════════════════
// ID + DATE PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════

export { DateTimeString } from './shared/datetime-string';
export type { Guid, Id } from './shared/id';
export { generateGuid, generateId } from './shared/id';

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════

export {
	createDisposableCache,
	type DisposableCache,
} from './cache/disposable-cache.js';

export { attachBroadcastChannel } from './document/attach-broadcast-channel.js';
export { attachEncryption } from './document/attach-encryption.js';
export { attachIndexedDb } from './document/attach-indexed-db.js';
export {
	attachKv,
	type InferKvValue,
	type Kv,
	type KvDefinitions,
} from './document/attach-kv.js';
export { attachPlainText } from './document/attach-plain-text.js';
export { attachRichText } from './document/attach-rich-text.js';
export {
	attachTable,
	attachTables,
	type BaseRow,
	type InferTableRow,
	type Table,
	type Tables,
} from './document/attach-table.js';
export { attachTimeline } from './document/attach-timeline/index.js';
export { defineKv } from './document/define-kv.js';
export { defineTable } from './document/define-table.js';
export {
	type ActionInput,
	type ActionOutput,
	DispatchError,
	type DispatchRequest,
	type LiveDevice,
	type TypedDispatch,
	typedDispatch,
} from './document/dispatch.js';
export { docGuid } from './document/doc-guid.js';
export {
	type CloudAppSync,
	openCloudAppSync,
} from './document/cloud-workspace-sync.js';
export type {
	OpenWebSocket,
	SyncStatus,
} from './document/internal/sync-supervisor.js';
export {
	createLocalOwner,
	type LocalOwner,
} from './document/local-owner.js';
export { onLocalUpdate } from './document/on-local-update.js';
export {
	type Collaboration,
	openCollaboration,
} from './document/open-collaboration.js';
// Transport URL builders (`roomWsUrl`, `websocketUrl`, `workspaceAppDocWsUrl`)
// are intentionally NOT re-exported. `/rooms/:room` is a daemon-only sync
// surface; the workspace/app/doc routing is owned by `openCloudAppSync`.
// Daemon code and the sync factory import from `./document/transport.js`
// directly so apps cannot open a parallel sync surface that bypasses
// Workspace membership.
