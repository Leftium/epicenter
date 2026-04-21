/**
 * Encrypted table primitives — bind one or many `TableDefinition`s to a Y.Doc
 * with encryption coordination through an `EncryptionAttachment`.
 *
 * Two entry points:
 *
 * - `attachEncryptedTable(ydoc, encryption, name, def)` — singular primitive.
 *   Creates one encrypted table and registers its store with the coordinator.
 *
 * - `attachEncryptedTables(ydoc, encryption, defs)` — batch sugar. Returns a
 *   record of typed helpers keyed by table name. Equivalent to calling
 *   `attachEncryptedTable` in a loop.
 *
 * Both return the typed helper directly. The backing store self-registers
 * with `encryption`, so the caller never handles it.
 *
 * @module
 */

import { TableKey } from '@epicenter/document';
import {
	AttachPrimitive,
	createTable,
	guardSlot,
} from '@epicenter/document/internal';
import type * as Y from 'yjs';
import type { EncryptionAttachment } from '../shared/attach-encryption.js';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import type {
	InferTableRow,
	Table,
	TableDefinition,
	TableDefinitions,
	Tables,
} from './types.js';

/**
 * Bind a single encrypted `TableDefinition` to a Y.Doc.
 *
 * Shares `AttachPrimitive.Table` with the plaintext `attachTable` from
 * `@epicenter/document` — mixing the two for the same name on one Y.Doc
 * throws.
 */
export function attachEncryptedTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly — defineTable already constrains schemas
	TTableDefinition extends TableDefinition<any>,
>(
	ydoc: Y.Doc,
	encryption: EncryptionAttachment,
	name: string,
	definition: TTableDefinition,
): Table<InferTableRow<TTableDefinition>> {
	guardSlot(ydoc, AttachPrimitive.Table, name);
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
