/**
 * attachEncryption: per-ydoc encryption coordinator.
 *
 * A workspace owns several `EncryptedYKeyValueLww` stores (one per table plus
 * the KV store). This attachment derives a per-workspace HKDF keyring at
 * construction time, activates every store, and returns the constructed
 * encrypted handles atomically:
 *
 * ```ts
 * const { tables, kv } = attachEncryption(ydoc, {
 *   keyring: () => ownerKeyring,
 *   tables: tableDefs,
 *   kv: kvDefs,
 * });
 * ```
 *
 * Slots are *definition maps* (not handles): encryption constructs the
 * encrypted store for every entry. Compare to the materializer primitives,
 * whose `tables:` slot takes already-constructed handles to mirror; here
 * `tables:` takes the same `TableDefinitions` you'd hand to plaintext
 * `attachTables`, and encryption returns the constructed `Tables<T>`.
 *
 * ## Key source: lazy callback, single derivation
 *
 * `keyring` is a callback into whoever owns identity. It's invoked once at
 * construction, derived into a per-workspace keyring via HKDF, and that
 * keyring activates every store before any handle is returned. Throw inside
 * `keyring()` if no keyring is available (e.g. signed-out): a throw here
 * means the workspace outlived its signed-in scope, which is a caller bug.
 *
 * Same-owner identity updates (key rotation, profile edits) do not flow
 * through this attachment. Authenticated apps reload the page on
 * different-owner transitions.
 *
 * ## Local persistence concerns live elsewhere
 *
 * Encrypted IndexedDB persistence and owner-scoped BroadcastChannel are
 * owner-scoped (one `(server, ownerId)` pair) rather than ydoc-scoped, so they
 * live on `attachLocalStorage(ydoc, { server, ownerId, keyring })`. Local-data
 * wipe lives on `wipeLocalStorage({ server, ownerId })`. Both are free
 * functions in this package; callers compose them around `attachEncryption`
 * at use sites.
 *
 * ## Disposal
 *
 * Each store hooks `ydoc.once('destroy', ...)` at construction, mirroring the
 * plaintext `attachTable` / `attachKv` primitives. Callers tear down
 * encryption by calling `ydoc.destroy()`: the attachment does not expose a
 * standalone `dispose()` method.
 *
 * ## What this attachment does NOT do
 *
 * - It does not wipe local storage. `wipeLocalStorage({ server, ownerId })` owns that.
 * - It does not validate that every encryption-capable slot on the Y.Doc got
 *   registered. The caller owns the composition: if you pair a plaintext
 *   `attachTable` with a `tables:` entry on `attachEncryption` targeting the
 *   *same slot name*, Yjs hands both calls the same underlying `Y.Array` and
 *   you get a silent plaintext-over-ciphertext race. One slot name, one
 *   attach site, one intent.
 *
 * ## Why `workspaceId` is read from `ydoc.guid`
 *
 * By construction, the workspace Y.Doc's `guid` equals the workspace id
 * (`new Y.Doc({ guid: id })`). Taking a separate `workspaceId` parameter
 * would invite drift between the two. `deriveWorkspaceKey` uses the id as an
 * HKDF domain-separation label: it doesn't care whether the string is the
 * guid or an explicit id, only that the two agree.
 *
 * @module
 */

import type { Keyring } from '@epicenter/encryption';
import type * as Y from 'yjs';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { createKv, type KvDefinitions } from './attach-kv.js';
import {
	createTable,
	type TableDefinitions,
	type Tables,
} from './attach-table.js';
import { deriveWorkspaceKeyring } from './derive-workspace-keyring.js';
import { KV_KEY, TableKey } from './keys.js';

export type AttachEncryptionOptions<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	/** Lazy reader for the current owner keyring; invoked once at construction. */
	keyring: () => Keyring;
	/**
	 * Table definitions to register as encrypted stores, keyed by table name.
	 * Pass the same record you'd hand to plaintext `attachTables`.
	 */
	tables: TTables;
	/**
	 * KV definitions to register on the encrypted KV singleton. Pass `{}` to
	 * register the slot without any typed keys (apps that don't read KV through
	 * the typed helper still want the slot claimed so the daemon syncs it).
	 */
	kv: TKv;
};

/**
 * Create the encrypted stores for a workspace Y.Doc and return them keyed by
 * name.
 *
 * Atomic: derives one per-workspace keyring, activates every store, and
 * returns the constructed `{ tables, kv }` bundle in a single call. No
 * temporal registration window, no mid-session attachment.
 */
export function attachEncryption<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	ydoc: Y.Doc,
	{
		keyring,
		tables: tableDefs,
		kv: kvDefs,
	}: AttachEncryptionOptions<TTables, TKv>,
) {
	const workspaceKeyring = deriveWorkspaceKeyring(keyring(), ydoc.guid);

	function attachStore(key: string) {
		const store = createEncryptedYkvLww(ydoc, key);
		ydoc.once('destroy', () => store[Symbol.dispose]());
		store.activateEncryption(workspaceKeyring);
		return store;
	}

	const tables = Object.fromEntries(
		Object.entries(tableDefs).map(([name, def]) => [
			name,
			createTable(attachStore(TableKey(name)), def, name),
		]),
	) as Tables<TTables>;

	const kv = createKv(attachStore(KV_KEY), kvDefs);

	return { tables, kv };
}

export type EncryptionAttachment<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = ReturnType<typeof attachEncryption<TTables, TKv>>;
