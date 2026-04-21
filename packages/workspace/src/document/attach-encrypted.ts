/**
 * Encrypted variant primitives — bind `TableDefinition`s and `KvDefinitions`
 * to a Y.Doc, coordinating encryption through an `EncryptionAttachment`.
 *
 * Three public entry points:
 *
 * - `attachEncryptedTable(ydoc, encryption, name, def)` — singular table.
 * - `attachEncryptedTables(ydoc, encryption, defs)` — batch sugar over
 *   `attachEncryptedTable`.
 * - `attachEncryptedKv(ydoc, encryption, defs)` — encrypted KV singleton.
 *
 * Each creates the backing `EncryptedYKeyValueLww` store, registers it with
 * the encryption coordinator, and returns the typed helper. The caller never
 * handles the store directly.
 *
 * Plaintext counterparts (`attachTable`, `attachTables`, `attachKv`) ship
 * alongside these in `@epicenter/workspace`. Do not mix plaintext and
 * encrypted wrappers on the same slot name — see `attach-encryption.ts` for why.
 *
 * @module
 */

import {
	KV_KEY,
	TableKey,
	type InferTableRow,
	type Kv,
	type KvDefinitions,
	type Table,
	type TableDefinition,
	type TableDefinitions,
	type Tables,
} from './index.js';
import { createKv, createTable } from './internal.js';
import type * as Y from 'yjs';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import type { EncryptionAttachment } from './attach-encryption.js';

/** Bind a single encrypted `TableDefinition` to a Y.Doc. */
export function attachEncryptedTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly — defineTable already constrains schemas
	TTableDefinition extends TableDefinition<any>,
>(
	ydoc: Y.Doc,
	encryption: EncryptionAttachment,
	name: string,
	definition: TTableDefinition,
): Table<InferTableRow<TTableDefinition>> {
	const store = createEncryptedYkvLww(ydoc, TableKey(name));
	encryption.register(store);
	return createTable(store, definition);
}

/**
 * Bind a record of encrypted `TableDefinition`s to a Y.Doc. Each entry is
 * attached as a separate encrypted store keyed by its name.
 */
export function attachEncryptedTables<T extends TableDefinitions>(
	ydoc: Y.Doc,
	encryption: EncryptionAttachment,
	definitions: T,
): Tables<T> {
	return Object.fromEntries(
		Object.entries(definitions).map(([name, def]) => [
			name,
			attachEncryptedTable(ydoc, encryption, name, def),
		]),
	) as Tables<T>;
}

/** Bind KV definitions to a Y.Doc as a single encrypted store. */
export function attachEncryptedKv<T extends KvDefinitions>(
	ydoc: Y.Doc,
	encryption: EncryptionAttachment,
	definitions: T,
): Kv<T> {
	const store = createEncryptedYkvLww(ydoc, KV_KEY);
	encryption.register(store);
	return createKv(store, definitions);
}
