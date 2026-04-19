/**
 * Transport origin sentinels for Yjs sync.
 *
 * Canonical definitions now live in `@epicenter/sync` so every layer that
 * touches a shared Y.Doc (workspace sync, document attachSync, BroadcastChannel)
 * agrees on the same symbols. This file re-exports them for existing
 * workspace-internal imports.
 *
 * Other origin Symbols in the codebase are intentionally NOT here:
 *
 * - `DOCUMENTS_ORIGIN` (create-documents.ts) — self-referential guard.
 *   The document manager writes to the workspace Y.Doc with this origin,
 *   then checks for it on the same Y.Doc to avoid re-triggering itself.
 *   Both the write and the check live in the same file.
 *
 * - `DEDUP_ORIGIN` (y-keyvalue-lww.ts), `REENCRYPT_ORIGIN`
 *   (y-keyvalue-lww-encrypted.ts) — internal self-loop guards for LWW
 *   conflict resolution and key rotation. They never leave their
 *   defining module.
 */

export { BC_ORIGIN, SYNC_ORIGIN } from '@epicenter/sync';
