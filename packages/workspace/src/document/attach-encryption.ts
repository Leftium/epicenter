/**
 * attachEncryption: per-ydoc encryption coordinator.
 *
 * A workspace owns several `EncryptedYKeyValueLww` stores (one per table plus
 * the KV store). This attachment coordinates key application across all of
 * them: it derives a per-workspace HKDF keyring from base64 user keys and
 * calls `activateEncryption(keyring)` on every registered store in lockstep.
 *
 * ## Method-on-coordinator pattern
 *
 * The coordinator owns the method surface for attaching its sibling
 * primitives. Instead of top-level `attachEncryptedTable(ydoc, encryption, ...)`
 * exports, call the methods on the returned attachment:
 *
 * ```ts
 * const encryption = attachEncryption(ydoc);
 * const tables = encryption.attachTables(defs);
 * const kv = encryption.attachKv(defs);
 * ```
 *
 * The method names deliberately mirror the plaintext primitives
 * (`attachTable`, `attachTables`, `attachKv`) so the pattern reads
 * symmetrically: "encryption's attach-tables" vs "plain attach-tables."
 *
 * ## Registration model
 *
 * Each method creates the backing `EncryptedYKeyValueLww` store, registers it
 * with the coordinator, and returns the typed helper. The coordinator holds
 * the list and applies the current keyring (if any) to each new registrant
 * immediately: so registering after `applyKeys` has run does not leave the
 * store plaintext.
 *
 * ## Keyring dedup
 *
 * Auth token refreshes fire `onLogin` repeatedly with identical key material.
 * The attachment keeps the last applied keyring so subsequent calls with the
 * same keys short-circuit before HKDF and per-store activation run. Equality is
 * order-independent: reversed key arrays are treated as the same keyring.
 *
 * ## Disposal
 *
 * The attachment registers a single `ydoc.on('destroy')` listener that
 * disposes every registered store. Callers tear down encryption by calling
 * `ydoc.destroy()`: the attachment does not expose a standalone `dispose()`
 * method.
 *
 * ## What this attachment does NOT do
 *
 * - It does not wipe CRDT state. Any future "wipe encrypted blobs" API needs
 *   to coordinate with persistence to be useful: design it alongside the
 *   consumer migration.
 * - It does not validate that every encryption-capable slot on the Y.Doc
 *   got registered. The caller owns the composition: if you pair a
 *   plaintext `attachTable` with `encryption.attachTable` targeting the
 *   *same slot name*, Yjs hands both calls the same underlying `Y.Array` and
 *   you get a silent plaintext-over-ciphertext race. The verb
 *   (`encryption.attachTable` vs plain `attachTable`) is the primary defense;
 *   review call sites accordingly. One slot name, one attach site, one intent.
 *
 * ## Why `workspaceId` is read from `ydoc.guid`
 *
 * By construction, the workspace Y.Doc's `guid` equals the workspace id
 * (`new Y.Doc({ guid: id })`). Taking a separate `workspaceId` parameter
 * would invite drift between the two. `deriveWorkspaceKey` uses the id as
 * an HKDF domain-separation label: it doesn't care whether the string is
 * the guid or an explicit id, only that the two agree.
 *
 * @module
 */

import {
	base64ToBytes,
	deriveWorkspaceKey,
	type EncryptionKeys,
	encryptionKeysEqual,
} from '@epicenter/encryption';
import type * as Y from 'yjs';
import {
	createEncryptedYkvLww,
	type EncryptedYKeyValueLww,
} from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import {
	attachEncryptedProvider,
	type EncryptedIndexedDbAttachment,
	type IndexedDbAttachment,
} from './attach-indexed-db.js';
import type { Kv, KvDefinitions } from './attach-kv.js';
import type {
	InferTableRow,
	ReadonlyTable,
	ReadonlyTables,
	Table,
	TableDefinition,
	TableDefinitions,
	Tables,
} from './attach-table.js';
import { createKv, createReadonlyTable, createTable } from './internal.js';
import { KV_KEY, TableKey } from './keys.js';
import { createOwnedYjsKey } from './local-yjs-key.js';

/**
 * The coordinator treats every registered store uniformly: it only calls
 * `activateEncryption(keyring)` and `dispose()`, neither of which depends on
 * the store's value type. `any` is the variance-friendly alias here.
 */
// biome-ignore lint/suspicious/noExplicitAny: variance
type AnyEncryptedStore = EncryptedYKeyValueLww<any>;

type EncryptedIndexedDbRegistrant = {
	targetYdoc: Y.Doc;
	attachment: EncryptedIndexedDbAttachment;
};

export type EncryptionAttachment = {
	/**
	 * Apply encryption keys to every registered store. Synchronous: HKDF via
	 * @noble/hashes and XChaCha20 via @noble/ciphers are both sync.
	 *
	 * On every call (including the first), every registered store walks its
	 * entries and converges them to the current-version key:
	 *
	 * - Plaintext entries → encrypted with the current-version key.
	 * - Ciphertext at a non-current version (but decryptable via the keyring)
	 *   → decrypted and re-encrypted with the current-version key.
	 * - Ciphertext already at the current version → no-op.
	 *
	 * This is how key rotation works: call `applyKeys` with the new keyring,
	 * and all at-rest data upgrades to the new key. The ciphertext upgrades
	 * propagate to peers via normal CRDT sync; eventually every device's live
	 * view contains only current-version ciphertext.
	 *
	 * Dedup: a second call with an identical keyring is a no-op.
	 * Order of the input array does not affect equality.
	 *
	 * Stores registered after this call will be auto-activated with the cached
	 * keyring at registration time.
	 */
	applyKeys(keys: EncryptionKeys): void;

	/**
	 * Attach an encrypted table to the coordinator's Y.Doc, with the store
	 * registered for encryption coordination.
	 */
	attachTable<
		// biome-ignore lint/suspicious/noExplicitAny: variance-friendly: defineTable already constrains schemas
		TTableDefinition extends TableDefinition<any>,
	>(
		name: string,
		definition: TTableDefinition,
	): Table<InferTableRow<TTableDefinition>>;

	attachReadonlyTable<
		// biome-ignore lint/suspicious/noExplicitAny: variance-friendly
		TTableDefinition extends TableDefinition<any>,
	>(
		name: string,
		definition: TTableDefinition,
	): ReadonlyTable<InferTableRow<TTableDefinition>>;

	/**
	 * Batch sugar over `attachTable`: one encrypted store per entry, keyed by
	 * name.
	 */
	attachTables<T extends TableDefinitions>(definitions: T): Tables<T>;

	attachReadonlyTables<T extends TableDefinitions>(
		definitions: T,
	): ReadonlyTables<T>;

	/**
	 * Attach the encrypted KV singleton to the coordinator's Y.Doc.
	 */
	attachKv<T extends KvDefinitions>(definitions: T): Kv<T>;

	/**
	 * Attach encrypted local IndexedDB persistence for a root or child Y.Doc.
	 *
	 * The encryption coordinator owns the user key source. Call `applyKeys`
	 * before attaching encrypted storage so the provider can hydrate from local
	 * ciphertext without a plaintext fallback.
	 */
	attachIndexedDb(
		targetYdoc: Y.Doc,
		opts: { userId: string },
	): IndexedDbAttachment;
};

/**
 * Create an encryption coordinator bound to `ydoc`.
 *
 * The returned coordinator owns `attachTable` / `attachTables` / `attachKv`
 * methods: call them to register encrypted stores. Call `applyKeys(keys)`
 * after login (or whenever the auth session produces keys) to activate
 * encryption across every registered store.
 */
export function attachEncryption(ydoc: Y.Doc): EncryptionAttachment {
	const stores: AnyEncryptedStore[] = [];
	const encryptedIndexedDbAttachments: EncryptedIndexedDbRegistrant[] = [];
	const workspaceId = ydoc.guid;

	/** Cache the last-applied keyring so late-registered stores can activate. */
	let cachedKeyring: Map<number, Uint8Array> | undefined;
	/** Last-applied encryption keys for same-key dedup. */
	let lastKeys: EncryptionKeys | undefined;

	ydoc.on('destroy', () => {
		for (const store of stores) store.dispose();
	});

	function register(store: AnyEncryptedStore): void {
		stores.push(store);
		if (cachedKeyring !== undefined) store.activateEncryption(cachedKeyring);
	}

	function deriveKeyring(
		keys: EncryptionKeys,
		targetWorkspaceId: string,
	): Map<number, Uint8Array> {
		const keyring = new Map<number, Uint8Array>();
		for (const { version, userKeyBase64 } of keys) {
			const userKey = base64ToBytes(userKeyBase64);
			keyring.set(version, deriveWorkspaceKey(userKey, targetWorkspaceId));
		}
		return keyring;
	}

	function requireKeys(): EncryptionKeys {
		if (lastKeys === undefined) {
			throw new Error(
				'Cannot attach encrypted IndexedDB: encryption coordinator has no keys. Call encryption.applyKeys(...) before attaching encrypted storage.',
			);
		}
		return lastKeys;
	}

	const attachment: EncryptionAttachment = {
		applyKeys(keys) {
			if (lastKeys !== undefined && encryptionKeysEqual(keys, lastKeys)) return;
			lastKeys = [...keys] as EncryptionKeys;

			const keyring = deriveKeyring(keys, workspaceId);
			cachedKeyring = keyring;
			for (const store of stores) store.activateEncryption(keyring);
			for (const registrant of encryptedIndexedDbAttachments) {
				registrant.attachment.activateEncryption(
					deriveKeyring(keys, registrant.targetYdoc.guid),
				);
			}
		},
		attachTable(name, definition) {
			const store = createEncryptedYkvLww(ydoc, TableKey(name));
			register(store);
			return createTable(store, definition, name);
		},
		attachReadonlyTable(name, definition) {
			const store = createEncryptedYkvLww(ydoc, TableKey(name));
			register(store);
			return createReadonlyTable(store, definition, name);
		},
		attachTables(definitions) {
			return Object.fromEntries(
				Object.entries(definitions).map(([name, def]) => [
					name,
					attachment.attachTable(name, def),
				]),
			) as Tables<typeof definitions>;
		},
		attachReadonlyTables(definitions) {
			return Object.fromEntries(
				Object.entries(definitions).map(([name, def]) => [
					name,
					attachment.attachReadonlyTable(name, def),
				]),
			) as ReadonlyTables<typeof definitions>;
		},
		attachKv(definitions) {
			const store = createEncryptedYkvLww(ydoc, KV_KEY);
			register(store);
			return createKv(store, definitions);
		},
		attachIndexedDb(targetYdoc, { userId }) {
			const keys = requireKeys();
			const attachment = attachEncryptedProvider(targetYdoc, {
				databaseName: createOwnedYjsKey(userId, targetYdoc.guid),
				keyring: deriveKeyring(keys, targetYdoc.guid),
			});
			encryptedIndexedDbAttachments.push({ targetYdoc, attachment });
			return attachment;
		},
	};

	return attachment;
}
