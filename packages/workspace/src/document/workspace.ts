/**
 * `createWorkspace`: the canonical entry point for opening a workspace-backed
 * Y.Doc.
 *
 * Subsumes the three-line ritual every browser/daemon mount used to repeat:
 *
 * ```ts
 * const ydoc = new Y.Doc({ guid, gc: true });
 * const { tables, kv } = attachEncryption(ydoc, { keyring, tables, kv });
 * const actions = createXActions(tables);
 * ```
 *
 * becomes
 *
 * ```ts
 * using workspace = createWorkspace({ id, keyring, tables, kv });
 * const actions = createXActions(workspace);
 * ```
 *
 * ## Encrypted vs plaintext
 *
 * `keyring` is optional. When present, every table and the KV store activate
 * encryption derived from the owner keyring narrowed to `id` (one HKDF step,
 * shared across all stores in this workspace). When absent, stores are
 * constructed plaintext. One factory, both modes.
 *
 * ## Disposal
 *
 * `using workspace` triggers `ydoc.destroy()`, which cascades through every
 * store's `ydoc.once('destroy', ...)` hook. No standalone dispose surface.
 *
 * ## Identity
 *
 * `options.id` is the constructor input; `workspace.ydoc.guid` is the
 * canonical read. By construction they agree, and downstream code should read
 * `workspace.ydoc.guid` only.
 *
 * @module
 */

import type { Keyring } from '@epicenter/encryption';
import * as Y from 'yjs';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { createKv, type Kv, type KvDefinitions } from './kv.js';
import {
	createTable,
	type TableDefinitions,
	type Tables,
} from './table.js';
import { deriveWorkspaceKeyring } from './derive-workspace-keyring.js';
import { KV_KEY, TableKey } from './keys.js';
import {
	type ObservableKvStore,
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './y-keyvalue/index.js';

export type Workspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	readonly ydoc: Y.Doc;
	readonly tables: Tables<TTables>;
	readonly kv: Kv<TKv>;
	[Symbol.dispose](): void;
};

export type CreateWorkspaceOptions<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	/**
	 * Stable workspace identifier. Stamped onto the Y.Doc as `guid`. Used as
	 * the HKDF domain-separation label when `keyring` is provided.
	 */
	id: string;

	/** Table definitions to materialize on the workspace root. */
	tables: TTables;

	/** KV definitions to materialize on the workspace root. Pass `{}` for none. */
	kv: TKv;

	/**
	 * Lazy reader for the current owner keyring. When provided, every table and
	 * the KV store activate encryption derived from this keyring narrowed to
	 * `id`. When absent, stores are constructed plaintext.
	 *
	 * Called synchronously at construction. Throw if no keyring is available
	 * (e.g. signed-out): a throw here means the caller built a workspace
	 * outside its signed-in scope, which is a bug.
	 */
	keyring?: () => Keyring;
};

/**
 * Build a fully wired workspace bundle: `{ ydoc, tables, kv, [Symbol.dispose] }`.
 *
 * Behavior:
 *   1. Construct `new Y.Doc({ guid: id, gc: true })`.
 *   2. If `keyring` is provided, derive the per-workspace keyring once via
 *      HKDF over `keyring()` + `id`, then activate every store with it.
 *   3. For each `tables[name]`: create an encrypted or plaintext YKV store on
 *      `ydoc.getArray(TableKey(name))` and wrap with `createTable`.
 *   4. For `kv`: same on `ydoc.getArray(KV_KEY)`, wrapped with `createKv`.
 *   5. Each store hooks `ydoc.once('destroy', ...)` for cascade disposal.
 *   6. `[Symbol.dispose]()` calls `ydoc.destroy()`.
 */
export function createWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	options: CreateWorkspaceOptions<TTables, TKv>,
): Workspace<TTables, TKv> {
	const ydoc = new Y.Doc({
		guid: options.id,
		gc: true,
	});

	const workspaceKeyring = options.keyring
		? deriveWorkspaceKeyring(options.keyring(), options.id)
		: null;

	function attachStore(arrayKey: string): ObservableKvStore<unknown> {
		if (workspaceKeyring) {
			const store = createEncryptedYkvLww<unknown>(ydoc, arrayKey);
			ydoc.once('destroy', () => store[Symbol.dispose]());
			store.activateEncryption(workspaceKeyring);
			return store;
		}
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(arrayKey);
		const ykv = new YKeyValueLww<unknown>(yarray);
		ydoc.once('destroy', () => ykv[Symbol.dispose]());
		return ykv;
	}

	const tables = Object.fromEntries(
		Object.entries(options.tables).map(([name, definition]) => [
			name,
			createTable(attachStore(TableKey(name)), definition, name),
		]),
	) as Tables<TTables>;

	const kv = createKv(attachStore(KV_KEY), options.kv);

	return {
		ydoc,
		tables,
		kv,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
