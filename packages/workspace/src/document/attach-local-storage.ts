/// <reference lib="dom" />

/**
 * `attachLocalStorage`: pair plaintext IndexedDB persistence with a
 * `(server, ownerId)`-scoped BroadcastChannel for a Y.Doc.
 *
 * One call covers both browser-local surfaces because they are always paired
 * for an authenticated workspace doc: writes that go to IDB also need to
 * cross-tab broadcast under the same owner scope, and the database
 * name and channel name must match so two tabs of the same owner share both
 * storage and live updates.
 *
 * Names are derived via {@link createOwnedYjsKey}. Two signed-in owners on
 * the same browser profile, or one owner signed into two different shared-wiki
 * servers on the same machine, never collide on local storage or
 * BroadcastChannel.
 *
 * Returns the IDB attachment so callers can await `whenLoaded` (e.g. to gate
 * `openCollaboration({ waitFor: idb.whenLoaded })`) or `whenDisposed` during
 * wipe orchestration.
 *
 * @module
 */

import type { Keyring } from '@epicenter/encryption';
import type { OwnerId } from '@epicenter/identity';
import type * as Y from 'yjs';
import { attachBroadcastChannel } from './attach-broadcast-channel.js';
import {
	attachIndexedDb,
	type IndexedDbAttachment,
} from './attach-indexed-db.js';
import { createOwnedYjsKey } from './local-yjs-key.js';

/**
 * Attach `(server, ownerId)`-scoped plaintext IndexedDB persistence plus a
 * matching BroadcastChannel to `ydoc`.
 *
 * `server` and `ownerId` are stable for the lifetime of the attachment: they
 * become the IDB database name and BroadcastChannel key prefix, so two
 * accounts on the same browser profile do not share local workspace data
 * and two shared-wiki deployments on the same machine do not collide either.
 * Snapshotted at attach time; session lifecycles guarantee stability by
 * disposing the workspace on sign-out and re-mounting on the next sign-in.
 *
 * @example
 * ```ts
 * const idb = attachLocalStorage(ydoc, signedIn);
 * await idb.whenLoaded;
 * ```
 */
export function attachLocalStorage(
	ydoc: Y.Doc,
	options: {
		server: string;
		ownerId: OwnerId;
		/**
		 * Retained during the trusted-relay migration so callers can be updated
		 * in a later pass. Persistence is plaintext now; this callback is no
		 * longer read.
		 */
		keyring?: () => Keyring;
	},
): IndexedDbAttachment {
	const databaseName = createOwnedYjsKey(
		options.server,
		options.ownerId,
		ydoc.guid,
	);
	const idb = attachIndexedDb(ydoc, { databaseName });
	attachBroadcastChannel(ydoc, databaseName);
	return idb;
}
