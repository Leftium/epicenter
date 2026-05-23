/// <reference lib="dom" />

/**
 * Browser-local owner facade for an authenticated workspace session.
 *
 * Holds the `(server, owner)` pair used to scope every browser-local
 * IndexedDB and BroadcastChannel name. Two signed-in accounts on the
 * same browser profile, or one account signed into two different team
 * servers on the same machine, never collide because both the server
 * origin and the owner partition appear in every local key.
 *
 * Daemons do not construct a local owner. They call `attachEncryption`
 * directly with `keyring` and persist through the filesystem instead of
 * IndexedDB.
 */

import type { Owner } from '@epicenter/auth';
import type { SubjectKeyring } from '@epicenter/encryption';
import { clearDocument } from 'y-indexeddb';
import type * as Y from 'yjs';
import { attachBroadcastChannel } from './attach-broadcast-channel.js';
import { attachEncryptedIndexedDb } from './attach-encrypted-indexed-db.js';
import { attachEncryption } from './attach-encryption.js';
import { createOwnedYjsKey, getOwnedYjsPrefix } from './local-yjs-key.js';

export type LocalOwner = ReturnType<typeof createLocalOwner>;

export function createLocalOwner({
	server,
	owner,
	keyring,
}: {
	/**
	 * API origin this session is signed into. Used as a path segment in
	 * every local storage key so two team servers on the same machine
	 * stay distinct.
	 */
	server: string;
	/**
	 * Discriminated owner the session resolves through. Personal owners
	 * partition local storage by user id; team owners share one local
	 * partition per `server` (the deployment IS the team).
	 */
	owner: Owner;
	keyring: () => SubjectKeyring;
}) {
	return {
		/**
		 * Attach per-ydoc encrypted tables and KV. Thin delegate to the free
		 * `attachEncryption(ydoc, { keyring })`; browsers go through the owner
		 * so the keyring callback never has to be re-passed.
		 */
		attachEncryption(ydoc: Y.Doc) {
			return attachEncryption(ydoc, { keyring });
		},
		/**
		 * Attach owner-scoped browser-local Yjs wiring: encrypted IndexedDB
		 * persistence plus cross-tab BroadcastChannel sync. Both names use
		 * `createOwnedYjsKey(server, owner, ydoc.guid)`, so two signed-in
		 * accounts in the same browser profile neither share local storage
		 * nor exchange plaintext updates over BroadcastChannel.
		 *
		 * Always paired in browser bundles, so the facade exposes one call
		 * instead of two. Returns the IDB attachment for `whenLoaded` /
		 * `whenDisposed` barriers.
		 */
		attachLocal(ydoc: Y.Doc) {
			const databaseName = createOwnedYjsKey(server, owner, ydoc.guid);
			const idb = attachEncryptedIndexedDb(ydoc, { databaseName, keyring });
			attachBroadcastChannel(ydoc, databaseName);
			return idb;
		},
		/**
		 * Delete every owner-scoped IndexedDB database currently visible to
		 * this browser profile, plus any explicitly named ones. Use from
		 * `wipe()` paths on sign-out so the next signed-in owner starts
		 * from a clean slate.
		 */
		async wipeLocalYjsData(ydocGuids: Iterable<string> = []) {
			const prefix = getOwnedYjsPrefix(server, owner);
			const names = new Set<string>();

			for (const guid of ydocGuids) {
				names.add(createOwnedYjsKey(server, owner, guid));
			}

			if ('databases' in indexedDB) {
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
