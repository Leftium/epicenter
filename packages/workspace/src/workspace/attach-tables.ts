/**
 * attachTables — internal helper that wires a set of workspace table
 * definitions onto a Y.Doc, returning the typed helpers plus the encrypted
 * stores for the encryption attachment to coordinate.
 *
 * @module
 */

import { TableKey } from '@epicenter/document';
import { createTable } from '@epicenter/document/internal';
import type * as Y from 'yjs';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import type { EncryptedYKeyValueLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import type { TableDefinitions, Tables } from './types.js';

export type TablesAttachment<T extends TableDefinitions> = {
	helpers: Tables<T>;
	stores: readonly EncryptedYKeyValueLww<any>[];
};

export function attachTables<T extends TableDefinitions>(
	ydoc: Y.Doc,
	definitions: T,
): TablesAttachment<T> {
	const entries = Object.entries(definitions).map(([name, def]) => {
		const store = createEncryptedYkvLww(ydoc, TableKey(name));
		return { name, store, helper: createTable(store, def) };
	});

	const helpers = Object.fromEntries(
		entries.map(({ name, helper }) => [name, helper]),
	) as Tables<T>;

	const stores = entries.map(({ store }) => store);

	return { helpers, stores };
}
