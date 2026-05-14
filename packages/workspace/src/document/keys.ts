/**
 * Y.Doc Array Key Conventions
 *
 * The document API stores data in Y.Arrays with these key patterns:
 * - Tables: `table:{tableName}` (one array per table)
 * - KV: `'kv'` (single array for all settings)
 * - RPC: `'rpc'` (single array for in-flight remote calls, backs `YKeyValueLww<Call>`)
 * - Presence: `'presence'` (single array for peer presence rows, backs `YKeyValueLww<PresenceEntry>`)
 *
 * These prefixes are reserved. Do not create Y.Doc arrays with
 * keys matching these patterns outside of the document API.
 *
 * @example
 * ```typescript
 * import { KV_KEY, RPC_KEY, PRESENCE_KEY, TableKey } from '@epicenter/workspace';
 *
 * const kvArray = ydoc.getArray(KV_KEY);                 // 'kv'
 * const postsArray = ydoc.getArray(TableKey('posts'));    // 'table:posts'
 * const rpcArray = ydoc.getArray(RPC_KEY);                // 'rpc'
 * const presenceArray = ydoc.getArray(PRESENCE_KEY);      // 'presence'
 * ```
 */

/** The KV settings array key. */
export const KV_KEY = 'kv';

/** Key type for the KV settings array. */
export type KvKey = typeof KV_KEY;

/** Key type for table arrays: `table:{tableName}`. */
export type TableKey<T extends string = string> = `table:${T}`;

/**
 * Create a table array key from a table name.
 *
 * The generic preserves the literal type when called with a string literal,
 * enabling precise type inference.
 */
export function TableKey<T extends string>(name: T): TableKey<T> {
	return `table:${name}`;
}

/** The RPC call array key. Backs `YKeyValueLww<Call>`. */
export const RPC_KEY = 'rpc';

/** The presence array key. Backs `YKeyValueLww<PresenceEntry>`. */
export const PRESENCE_KEY = 'presence';
