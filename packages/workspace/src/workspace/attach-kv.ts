/**
 * attachEncryptedKv — bind KV definitions to a Y.Doc with encryption
 * coordination through an `EncryptionAttachment`.
 *
 * Returns the typed `Kv<T>` helper directly. The backing store self-registers
 * with `encryption`, so the caller never handles it.
 *
 * @module
 */

import { KV_KEY } from '@epicenter/document';
import {
	AttachPrimitive,
	createKv,
	guardSingleton,
} from '@epicenter/document/internal';
import type * as Y from 'yjs';
import type { EncryptionAttachment } from '../shared/attach-encryption.js';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import type { Kv, KvDefinitions } from './types.js';

export function attachEncryptedKv<T extends KvDefinitions>(
	ydoc: Y.Doc,
	encryption: EncryptionAttachment,
	definitions: T,
): Kv<T> {
	guardSingleton(ydoc, AttachPrimitive.Kv);
	const store = createEncryptedYkvLww(ydoc, KV_KEY);
	encryption.register(store);
	return createKv(store, definitions) as Kv<T>;
}
