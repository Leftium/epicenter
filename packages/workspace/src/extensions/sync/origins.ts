/**
 * Transport origin sentinels for Yjs sync.
 *
 * Every transport that applies remote updates to a Y.Doc must tag them
 * with an origin Symbol so other handlers can skip re-broadcasting:
 *
 * - BroadcastChannel applies with `BC_ORIGIN`
 * - WebSocket applies with `SYNC_ORIGIN`
 * - The `onUpdate` handler in `create-documents.ts` skips all Symbol
 *   origins via `typeof origin === 'symbol'`—this convention means
 *   local edits (y-prosemirror uses a PluginKey object, direct
 *   mutations use null) pass through while transport-delivered updates
 *   are ignored.
 *
 * If you add a new transport, define its origin here as a Symbol.
 *
 * @module
 */

/** Origin for updates applied from BroadcastChannel cross-tab sync. */
export const BC_ORIGIN = Symbol('bc-sync');

/** Origin for updates applied from the WebSocket server. */
export const SYNC_ORIGIN = Symbol('sync-transport');
