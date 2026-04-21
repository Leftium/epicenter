/**
 * attachEncryption — per-ydoc encryption coordinator.
 *
 * A workspace owns several `EncryptedYKeyValueLww` stores (one per table plus
 * the KV store). This attachment coordinates key application across all of
 * them: it derives a per-workspace HKDF keyring from base64 user keys and
 * calls `activateEncryption(keyring)` on every registered store in lockstep.
 *
 * ## Registration model
 *
 * Encrypted primitives (`attachEncryptedTable`, `attachEncryptedTables`,
 * `attachEncryptedKv`) create their store, then call
 * `encryption.register(store)`. The coordinator holds the list and applies
 * the current keyring (if any) to each new registrant immediately — so
 * registering after `applyKeys` has run does not leave the store plaintext.
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
 * disposes every registered store and resolves `whenDisposed`. Callers tear
 * down encryption by calling `ydoc.destroy()` — the attachment does not
 * expose a standalone `dispose()` method.
 *
 * ## What this attachment does NOT do
 *
 * - It does not wipe CRDT state. Any future "wipe encrypted blobs" API needs
 *   to coordinate with persistence to be useful — design it alongside the
 *   consumer migration.
 * - It does not own store creation. Stores are created by
 *   `attachEncryptedTable` / `attachEncryptedKv` (or by test setup) and
 *   registered here. This attachment only coordinates the encryption
 *   lifecycle across whatever stores get registered.
 * - It does not validate that every encryption-capable slot on the Y.Doc
 *   got registered. The caller owns the composition — if you pair a
 *   plaintext `attachTable` from `@epicenter/document` with an
 *   `attachEncryptedTable` targeting the *same slot name*, Yjs hands both
 *   calls the same underlying `Y.Array` and you get a silent
 *   plaintext-over-ciphertext race. The verb (`attachEncryptedTable` vs
 *   `attachTable`) is the primary defense; review call sites accordingly.
 *   One slot name, one attach site, one intent.
 *
 * ## Why `workspaceId` is read from `ydoc.guid`
 *
 * By construction, the workspace Y.Doc's `guid` equals the workspace id
 * (`new Y.Doc({ guid: id })`). Taking a separate `workspaceId` parameter
 * would invite drift between the two. `deriveWorkspaceKey` uses the id as
 * an HKDF domain-separation label — it doesn't care whether the string is
 * the guid or an explicit id, only that the two agree.
 *
 * @module
 */

import type * as Y from 'yjs';
import { base64ToBytes, deriveWorkspaceKey } from './crypto/index.js';
import type { EncryptedYKeyValueLww } from './y-keyvalue/y-keyvalue-lww-encrypted.js';
import {
	type EncryptionKeys,
	encryptionKeysFingerprint,
} from '../workspace/encryption-key.js';

/**
 * The coordinator treats every registered store uniformly — it only calls
 * `activateEncryption(keyring)` and `dispose()`, neither of which depends on
 * the store's value type. `any` is the variance-friendly alias here.
 */
// biome-ignore lint/suspicious/noExplicitAny: variance
type AnyEncryptedStore = EncryptedYKeyValueLww<any>;

export type EncryptionAttachment = {
	/**
	 * Apply encryption keys to every registered store. Synchronous — HKDF via
	 * @noble/hashes and XChaCha20 via @noble/ciphers are both sync.
	 *
	 * Dedup: a second call with a fingerprint-identical keyring is a no-op.
	 * Order of the input array does not affect the fingerprint.
	 *
	 * Stores registered after this call will be auto-activated with the cached
	 * keyring at registration time.
	 */
	applyKeys(keys: EncryptionKeys): void;

	/**
	 * Register a store for encryption coordination. Internal entry point —
	 * called by `attachEncryptedTable` / `attachEncryptedKv` / test setup,
	 * not by application code.
	 *
	 * If keys have already been applied, the store is activated immediately
	 * with the cached keyring. Otherwise it is queued for the next
	 * `applyKeys` call.
	 */
	register(store: AnyEncryptedStore): void;

	/** Resolves when the Y.Doc is destroyed and every store has been disposed. */
	readonly whenDisposed: Promise<void>;
};

/**
 * Create an encryption coordinator bound to `ydoc`.
 *
 * The returned object has no knowledge of which stores will be encrypted —
 * they register themselves via `encryption.register(store)` during their
 * `attachEncrypted*` calls. Call `applyKeys(keys)` after login (or whenever
 * the auth session produces keys) to activate encryption across every
 * registered store.
 */
export function attachEncryption(ydoc: Y.Doc): EncryptionAttachment {
	const stores: AnyEncryptedStore[] = [];
	const workspaceId = ydoc.guid;

	/** Cache the last-applied keyring so late-registered stores can activate. */
	let cachedKeyring: Map<number, Uint8Array> | undefined;
	/** Fingerprint of the last-applied encryption keys for same-key dedup. */
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
		applyKeys(keys) {
			const fingerprint = encryptionKeysFingerprint(keys);
			if (fingerprint === lastKeysFingerprint) return;
			lastKeysFingerprint = fingerprint;

			const keyring = new Map<number, Uint8Array>();
			for (const { version, userKeyBase64 } of keys) {
				const userKey = base64ToBytes(userKeyBase64);
				keyring.set(version, deriveWorkspaceKey(userKey, workspaceId));
			}
			cachedKeyring = keyring;
			for (const store of stores) store.activateEncryption(keyring);
		},
		register(store) {
			stores.push(store);
			if (cachedKeyring !== undefined) store.activateEncryption(cachedKeyring);
		},
		whenDisposed,
	};
}
