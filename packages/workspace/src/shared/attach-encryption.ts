/**
 * attachEncryption — bind a shared encryption lifecycle to a set of encrypted stores on a Y.Doc.
 *
 * A workspace owns several `EncryptedYKeyValueLww` stores (one per table plus
 * the KV store). This attachment coordinates key application across all of
 * them: it decodes the base64 user keys, derives a per-workspace HKDF keyring,
 * and calls `activateEncryption(keyring)` on every store in lockstep.
 *
 * ## Fingerprint dedup
 *
 * Auth token refreshes fire `onLogin` repeatedly with identical key material.
 * The attachment holds a `lastKeysFingerprint` so subsequent calls with the
 * same keys short-circuit before HKDF and per-store activation run. The
 * fingerprint is order-independent — reversed key arrays produce the same
 * fingerprint (see `encryptionKeysFingerprint`).
 *
 * ## Disposal
 *
 * The attachment registers a single `ydoc.on('destroy')` listener that
 * disposes every store it owns and resolves `whenDisposed`. Callers tear down
 * encryption by calling `ydoc.destroy()` — the attachment does not expose a
 * standalone `dispose()` method.
 *
 * ## What this attachment does NOT do
 *
 * - It does not wipe CRDT state. The old `createWorkspace.clearLocalData()`
 *   iterated extension callbacks (IndexedDB wipe + similar); that semantic
 *   lives in persistence attachments, not here. Any future "wipe encrypted
 *   blobs" API needs to coordinate with persistence to be useful — design it
 *   alongside the consumer migration.
 * - It does not own store creation. Stores are created by `attachTables` /
 *   `attachKv` (for workspace) or by test setup (for standalone encryption
 *   tests). This attachment only coordinates the encryption lifecycle across
 *   whatever stores it's handed.
 *
 * ## Why `workspaceId` is read from `ydoc.guid`
 *
 * By construction, the workspace Y.Doc's `guid` equals the workspace id
 * (`new Y.Doc({ guid: id })`). Taking a separate `workspaceId` parameter would
 * invite drift between the two. `deriveWorkspaceKey` uses the id as an HKDF
 * domain-separation label — it doesn't care whether the string is the guid or
 * an explicit id, only that the two agree.
 *
 * @module
 */

import { guardSingleton } from '@epicenter/document/internal';
import type * as Y from 'yjs';
import { base64ToBytes, deriveWorkspaceKey } from './crypto/index.js';
import type { EncryptedYKeyValueLww } from './y-keyvalue/y-keyvalue-lww-encrypted.js';
import {
	type EncryptionKeys,
	encryptionKeysFingerprint,
} from '../workspace/encryption-key.js';

export type EncryptionAttachment = {
	/**
	 * Apply encryption keys to every store. Synchronous — HKDF via @noble/hashes
	 * and XChaCha20 via @noble/ciphers are both sync.
	 *
	 * Dedup: a second call with a fingerprint-identical keyring is a no-op.
	 * Order of the input array does not affect the fingerprint.
	 *
	 * Once activated, stores permanently refuse plaintext writes. The only
	 * reset path is `clearLocalData()` followed by a fresh workspace.
	 */
	applyKeys(keys: EncryptionKeys): void;

	/** The encrypted stores this attachment coordinates. */
	readonly stores: readonly EncryptedYKeyValueLww<any>[];

	/** Resolves when the Y.Doc is destroyed and every store has been disposed. */
	readonly whenDisposed: Promise<void>;
};

/**
 * Minimal structural shape of a `TablesAttachment` — typed locally to avoid
 * an import cycle from `shared/` into `workspace/`. The real
 * `TablesAttachment<T>` in `../workspace/attach-tables.js` is assignable to
 * this shape.
 */
type TablesLike = { stores: readonly EncryptedYKeyValueLww<any>[] };

/**
 * Minimal structural shape of a `KvAttachment` — typed locally to avoid an
 * import cycle from `shared/` into `workspace/`. The real `KvAttachment<T>`
 * in `../workspace/attach-kv.js` is assignable to this shape.
 */
type KvLike = { store: EncryptedYKeyValueLww<any> };

/**
 * Attach encryption to the encrypted stores owned by a workspace's tables
 * and KV.
 *
 * Preferred shape: pass the attachment objects (`{ tables, kv }`) and let the
 * function aggregate their stores. This prevents the bug where a caller
 * forgets to include a store in a manual array — which would silently leave
 * that store writing plaintext.
 *
 * Escape hatch: pass `{ stores }` directly when constructing stores outside
 * of `attachTables` / `attachKv` (standalone encryption tests do this).
 */
export function attachEncryption(
	ydoc: Y.Doc,
	source:
		| { tables?: TablesLike; kv?: KvLike }
		| { stores: readonly EncryptedYKeyValueLww<any>[] },
): EncryptionAttachment {
	guardSingleton(ydoc, 'attachEncryption', 'encryption');
	const stores: readonly EncryptedYKeyValueLww<any>[] =
		'stores' in source
			? source.stores
			: [
					...(source.tables?.stores ?? []),
					...(source.kv ? [source.kv.store] : []),
				];

	const workspaceId = ydoc.guid;

	// Fingerprint of the last-applied encryption keys for same-key dedup.
	// Token refreshes fire applyKeys repeatedly with identical keys — this
	// skips the expensive base64 decode → HKDF → per-store scan path.
	let lastKeysFingerprint: string | undefined;

	let resolveDisposed!: () => void;
	const whenDisposed = new Promise<void>((resolve) => {
		resolveDisposed = resolve;
	});

	ydoc.on('destroy', () => {
		for (const store of stores) store.dispose();
		resolveDisposed();
	});

	return {
		applyKeys(keys: EncryptionKeys): void {
			const fingerprint = encryptionKeysFingerprint(keys);
			if (fingerprint === lastKeysFingerprint) return;
			lastKeysFingerprint = fingerprint;

			const keyring = new Map<number, Uint8Array>();
			for (const { version, userKeyBase64 } of keys) {
				const userKey = base64ToBytes(userKeyBase64);
				keyring.set(version, deriveWorkspaceKey(userKey, workspaceId));
			}
			for (const store of stores) {
				store.activateEncryption(keyring);
			}
		},
		stores,
		whenDisposed,
	};
}
