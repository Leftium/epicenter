/// <reference lib="dom" />

/**
 * createLocalOwner: identity-scoped facade for authenticated browser
 * workspaces.
 *
 * One owner per signed-in user session. Every browser-local Yjs artifact
 * (IndexedDB database name, BroadcastChannel key, wipe namespace) is keyed by
 * `(userId, ydocGuid)`, and every encrypted resource is bound to the same
 * user's encryption keys. The owner is the one named place that knows the
 * pair.
 *
 * ## What the methods own
 *
 * - `attachEncryption(ydoc)` is a thin delegate to the free
 *   `attachEncryption(ydoc, { encryptionKeys })`. Browsers go through the owner
 *   so the encryption keys never have to be re-passed at every doc.
 * - `attachIndexedDb(ydoc)` is the join point between encryption and local
 *   ownership: it derives the per-doc keyring AND the owner-scoped database
 *   name, then attaches an encrypted IndexedDB provider.
 * - `attachBroadcastChannel(ydoc)` opens a cross-tab channel under an
 *   owner-scoped key so two signed-in users in the same browser profile
 *   cannot exchange plaintext updates.
 * - `wipeLocalYjsData(ydocGuids)` deletes every owner-scoped IndexedDB
 *   database visible to this profile, plus any explicitly provided guids.
 *   Browsers call this from `wipe()` on sign-out and from the "forget device"
 *   action.
 *
 * Daemons do not construct an owner: they call `attachEncryption` directly
 * with just `encryptionKeys` and persist via filesystem instead of IDB.
 */

import type { EncryptionKeys } from '@epicenter/encryption';
import { clearDocument } from 'y-indexeddb';
import type * as Y from 'yjs';
import { attachBroadcastChannelWithKey } from './attach-broadcast-channel.js';
import { attachEncryptedIndexedDb } from './attach-encrypted-indexed-db.js';
import {
	attachEncryption,
	type EncryptionAttachment,
} from './attach-encryption.js';
import type { IndexedDbAttachment } from './attach-indexed-db.js';
import { deriveWorkspaceKeyring } from './derive-workspace-keyring.js';
import { createOwnedYjsKey, createOwnedYjsKeyPrefix } from './local-yjs-key.js';

export type LocalOwner = {
	readonly userId: string;
	/**
	 * Attach per-ydoc encrypted tables and KV. Equivalent to calling the free
	 * `attachEncryption(ydoc, { encryptionKeys })` but reads the owner's keys
	 * implicitly.
	 */
	attachEncryption(ydoc: Y.Doc): EncryptionAttachment;
	/**
	 * Attach encrypted local IndexedDB persistence. The database name is
	 * `createOwnedYjsKey(userId, ydoc.guid)` so other signed-in users on the
	 * same browser profile cannot read this user's persisted CRDT state.
	 */
	attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment;
	/**
	 * Attach owner-scoped cross-tab BroadcastChannel sync.
	 */
	attachBroadcastChannel(ydoc: Y.Doc): void;
	/**
	 * Delete every owner-scoped IndexedDB database currently visible to this
	 * browser profile, plus any explicitly named ones. Use from `wipe()` paths
	 * on sign-out so the next signed-in user starts from a clean slate.
	 */
	wipeLocalYjsData(ydocGuids?: Iterable<string>): Promise<void>;
};

type IndexedDbDatabaseInfo = { name?: string | null };
type IndexedDbFactoryWithDatabases = IDBFactory & {
	databases?: () => Promise<IndexedDbDatabaseInfo[]>;
};

export function createLocalOwner({
	userId,
	encryptionKeys,
}: {
	userId: string;
	encryptionKeys: () => EncryptionKeys;
}): LocalOwner {
	return {
		userId,
		attachEncryption(ydoc) {
			return attachEncryption(ydoc, { encryptionKeys });
		},
		attachIndexedDb(ydoc) {
			const keyring = deriveWorkspaceKeyring(encryptionKeys(), ydoc.guid);
			if (keyring.size === 0) {
				throw new Error(
					'Cannot attach encrypted IndexedDB provider: encryptionKeys() returned no usable keys.',
				);
			}
			const version = Math.max(...keyring.keys());
			const bytes = keyring.get(version)!;
			return attachEncryptedIndexedDb(ydoc, {
				databaseName: createOwnedYjsKey(userId, ydoc.guid),
				writeKey: { version, bytes },
				keyring,
			});
		},
		attachBroadcastChannel(ydoc) {
			attachBroadcastChannelWithKey(
				ydoc,
				createOwnedYjsKey(userId, ydoc.guid),
			);
		},
		async wipeLocalYjsData(ydocGuids = []) {
			const indexedDB = globalThis.indexedDB as | IndexedDbFactoryWithDatabases | undefined;
			const prefix = createOwnedYjsKeyPrefix(userId);
			const names = new Set<string>();

			for (const guid of ydocGuids) {
				names.add(createOwnedYjsKey(userId, guid));
			}

			if (indexedDB?.databases) {
				const databases = await indexedDB.databases().catch(() => []);
				for (const database of databases) {
					if (typeof database.name !== 'string') continue;
					if (!database.name.startsWith(prefix)) continue;
					names.add(database.name);
				}
			}

			await Promise.all([...names].map((name) => clearDocument(name)));
		},
	};
}
