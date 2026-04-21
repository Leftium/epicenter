/**
 * attachKv — internal helper that wires KV field definitions onto a Y.Doc,
 * returning the typed helper plus the single encrypted store for the
 * encryption attachment to coordinate.
 *
 * @module
 */

import { KV_KEY } from '@epicenter/document';
import { createKv, guardSingleton } from '@epicenter/document/internal';
import type * as Y from 'yjs';
import {
	createEncryptedYkvLww,
	type EncryptedYKeyValueLww,
} from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import type { Kv, KvDefinitions } from './types.js';

export type KvAttachment<T extends KvDefinitions> = {
	helper: Kv<T>;
	store: EncryptedYKeyValueLww<any>;
};

export function attachKv<T extends KvDefinitions>(
	ydoc: Y.Doc,
	definitions: T,
): KvAttachment<T> {
	guardSingleton(ydoc, 'attachKv');
	const store = createEncryptedYkvLww(ydoc, KV_KEY);
	const helper = createKv(store, definitions) as Kv<T>;
	return { helper, store };
}
