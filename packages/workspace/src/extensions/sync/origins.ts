/**
 * Transport origin sentinels for Yjs sync.
 *
 * These Symbols live in a shared file because multiple modules participate
 * in the same echo-prevention protocol: the BC handler needs to know about
 * SYNC_ORIGIN (to not re-broadcast server updates), the WS handler needs to
 * know about BC_ORIGIN (to not re-send tab-synced updates), and the
 * `onUpdate` handler in `create-documents.ts` uses `typeof origin === 'symbol'`
 * to skip all transport-delivered updates at once. No single module owns
 * these—they're a cross-cutting contract.
 *
 * Other origin Symbols in the codebase are intentionally NOT here:
 *
 * - `DOCUMENTS_ORIGIN` (create-documents.ts)—a self-referential guard.
 *   The document manager writes to the workspace Y.Doc with this origin,
 *   then checks for it on the same Y.Doc to avoid re-triggering itself.
 *   Both the write and the check live in the same file. No other module
 *   needs to see it.
 *
 * - `DEDUP_ORIGIN` (y-keyvalue-lww.ts), `REENCRYPT_ORIGIN`
 *   (y-keyvalue-lww-encrypted.ts)—internal self-loop guards for LWW
 *   conflict resolution and key rotation. They never leave their
 *   defining module.
 *
 * Convention: every transport that applies remote updates to a Y.Doc must
 * tag them with a Symbol origin defined here. The `typeof origin === 'symbol'`
 * check in create-documents.ts relies on this—local edits use non-Symbol
 * origins (y-prosemirror uses a PluginKey object, direct mutations use null).
 *
 * If you add a new transport, define its origin here as a Symbol.
 *
 * @module
 */

/** Origin for updates applied from BroadcastChannel cross-tab sync. */
export const BC_ORIGIN = Symbol('bc-sync');

/** Origin for updates applied from the WebSocket server. */
export const SYNC_ORIGIN = Symbol('sync-transport');
