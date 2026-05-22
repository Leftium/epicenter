/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * `@epicenter/workspace` attaches typed primitives: tables, KV, plain/rich
 * text, timeline, and an action registry to a `Y.Doc`, then wires the
 * result to IndexedDB persistence, end-to-end encryption, and WebSocket
 * sync via `openCollaboration`. `openCollaboration` also consumes the
 * server-owned presence channel and exposes the live-device surface
 * (`devices.list()`) plus HTTP-backed `dispatch()` for cross-device calls.
 *
 * @example
 * ```typescript
 * import {
 *   attachIndexedDb,
 *   attachRichText,
 *   attachTables,
 *   createDisposableCache,
 *   createInstallationId,
 *   defaultWorkspaceAppDocWsUrl,
 *   defineTable,
 *   docGuid,
 *   openCollaboration,
 * } from '@epicenter/workspace';
 * import type { AuthClient } from '@epicenter/auth';
 * import { type } from 'arktype';
 * import * as Y from 'yjs';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
 * declare const auth: AuthClient;
 *
 * const apiUrl = 'https://api.example.com';
 * const installationId = createInstallationId({ storage: localStorage });
 *
 * // The server resolves the workspace from the auth token, so the client
 * // builds the sync URL from (apiUrl, appId, docId) with no workspace lookup.
 * const ydoc = new Y.Doc({ guid: 'notes' });
 * const tables = attachTables(ydoc, { posts });
 * const idb = attachIndexedDb(ydoc);
 * const collaboration = openCollaboration(ydoc, {
 *   url: defaultWorkspaceAppDocWsUrl(apiUrl, { appId: 'notes', docId: 'root' }),
 *   openWebSocket: auth.openWebSocket,
 *   waitFor: idb.whenLoaded,
 *   installationId,
 *   actions: {},
 * });
 *
 * // Content docs build the same URL with their own docId. The local Y.Doc
 * // guid doubles as the cloud docId, so there is no second id system.
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
 *     const bodySync = openCollaboration(bodyYdoc, {
 *       url: defaultWorkspaceAppDocWsUrl(apiUrl, {
 *         appId: 'notes',
 *         docId: bodyYdoc.guid,
 *       }),
 *       openWebSocket: auth.openWebSocket,
 *       waitFor: bodyIdb.whenLoaded,
 *       installationId,
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
// Transport URL builders.
//
// `defaultWorkspaceAppDocWsUrl` is re-exported because apps build the URL
// themselves when calling `openCollaboration` directly: the server resolves
// the workspaceId from the auth token, so no client-side workspace lookup
// is required.
//
// `roomWsUrl` and `workspaceAppDocWsUrl` are intentionally NOT re-exported.
// `/rooms/:room` is a daemon-only sync surface, and the explicit-workspace
// route is owned by the daemon path; both import from
// `./document/transport.js` directly so apps cannot open a parallel sync
// surface that bypasses Workspace membership.
export { defaultWorkspaceAppDocWsUrl } from './document/transport.js';
