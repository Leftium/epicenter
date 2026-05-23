/**
 * `openEncryptedDoc`: construct an encrypted workspace Y.Doc with an attached
 * encryption coordinator.
 *
 * Owns Y.Doc construction so `guid` (used as the HKDF domain-separation label
 * for the per-workspace keyring) and `clientId` are right by construction. The
 * returned bundle exposes the attach surface for encrypted tables and KV; the
 * caller never sees the bare coordinator, and the only way to register
 * encrypted resources is through the bundle's methods.
 *
 * Construction order:
 *   1. `new Y.Doc({ guid: id, gc: true })`
 *   2. If `clientId !== undefined`, pin `ydoc.clientID`.
 *   3. Bind the `keyring` callback for lazy reads at each attach site.
 *   4. Return `{ ydoc, attachTable*, attachKv, [Symbol.dispose] }`.
 *
 * Disposal: `[Symbol.dispose]()` calls `ydoc.destroy()`, which triggers each
 * encrypted store's `Symbol.dispose` via the `destroy` listener registered at
 * attach time. Callers tear down by disposing the bundle.
 *
 * Local storage and cloud sync are deliberately not part of this primitive:
 * `attachLocalStorage(ydoc, identity)` and `openCollaboration(ydoc, opts)` are
 * called separately. The pairing is a per-app composition concern.
 *
 * @module
 */

import type { SubjectKeyring } from '@epicenter/encryption';
import * as Y from 'yjs';
import {
	createEncryptedYkvLww,
	type EncryptedYKeyValueLww,
} from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { createKv, type Kv, type KvDefinitions } from './attach-kv.js';
import {
	createReadonlyTable,
	createTable,
	type InferTableRow,
	type ReadonlyTable,
	type ReadonlyTables,
	type Table,
	type TableDefinition,
	type TableDefinitions,
	type Tables,
} from './attach-table.js';
import { deriveWorkspaceKeyring } from './derive-workspace-keyring.js';
import { KV_KEY, TableKey } from './keys.js';

export type OpenEncryptedDocOptions = {
	/**
	 * Y.Doc guid. Doubles as the HKDF domain-separation label that
	 * `deriveWorkspaceKeyring` mixes into the subject keyring, so the same
	 * subject keyring yields distinct per-workspace keys.
	 */
	id: string;
	/**
	 * Lazy reader for the current subject keyring. Called synchronously at every
	 * `attachTable` / `attachKv` site. Throw if no keyring is available (e.g.
	 * signed-out): a throw here means the caller outlived its signed-in scope.
	 */
	keyring: () => SubjectKeyring;
	/**
	 * Pin the Y.Doc `clientID`. Daemons hash `projectDir` so two daemons in
	 * different project directories produce distinct update streams. Browsers
	 * leave this undefined (Yjs assigns a random clientID per session).
	 */
	clientId?: number;
};

export type EncryptedDoc = {
	ydoc: Y.Doc;
	attachTable<
		// biome-ignore lint/suspicious/noExplicitAny: variance-friendly; defineTable constrains schemas
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
	attachTables<T extends TableDefinitions>(definitions: T): Tables<T>;
	attachReadonlyTables<T extends TableDefinitions>(
		definitions: T,
	): ReadonlyTables<T>;
	attachKv<T extends KvDefinitions>(definitions: T): Kv<T>;
	[Symbol.dispose](): void;
};

/**
 * Create an encrypted workspace Y.Doc.
 *
 * @example
 * ```ts
 * const ws = openEncryptedDoc({
 *   id: 'epicenter.fuji',
 *   keyring: signedIn.keyring,
 * });
 * const tables = ws.attachTables(fujiTables);
 * const kv = ws.attachKv({});
 * // later, on teardown:
 * ws[Symbol.dispose]();
 * ```
 */
export function openEncryptedDoc(
	options: OpenEncryptedDocOptions,
): EncryptedDoc {
	const ydoc = new Y.Doc({ guid: options.id, gc: true });
	if (options.clientId !== undefined) ydoc.clientID = options.clientId;
	const workspaceId = ydoc.guid;

	// biome-ignore lint/suspicious/noExplicitAny: variance
	function attachStore(key: string): EncryptedYKeyValueLww<any> {
		const store = createEncryptedYkvLww(ydoc, key);
		ydoc.once('destroy', () => store[Symbol.dispose]());
		store.activateEncryption(
			deriveWorkspaceKeyring(options.keyring(), workspaceId),
		);
		return store;
	}

	const bundle: EncryptedDoc = {
		ydoc,
		attachTable(name, definition) {
			return createTable(attachStore(TableKey(name)), definition, name);
		},
		attachReadonlyTable(name, definition) {
			return createReadonlyTable(
				attachStore(TableKey(name)),
				definition,
				name,
			);
		},
		attachTables(definitions) {
			return Object.fromEntries(
				Object.entries(definitions).map(([name, def]) => [
					name,
					bundle.attachTable(name, def),
				]),
			) as Tables<typeof definitions>;
		},
		attachReadonlyTables(definitions) {
			return Object.fromEntries(
				Object.entries(definitions).map(([name, def]) => [
					name,
					bundle.attachReadonlyTable(name, def),
				]),
			) as ReadonlyTables<typeof definitions>;
		},
		attachKv(definitions) {
			return createKv(attachStore(KV_KEY), definitions);
		},
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};

	return bundle;
}
