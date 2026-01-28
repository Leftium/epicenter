/**
 * KV Store for Cell Workspace
 *
 * Stores workspace-level key-value pairs in Y.Doc using YKeyValueLww.
 * Simple string keys (no prefixing needed).
 *
 * @packageDocumentation
 */

import type * as Y from 'yjs';
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../../core/utils/y-keyvalue-lww';
import { validateId } from '../keys';
import type { ChangeEvent, ChangeHandler, KvStore } from '../types';

/**
 * Y.Array name for KV store.
 */
export const KV_ARRAY_NAME = 'kv';

/**
 * Create a KV store backed by YKeyValueLww.
 */
export function createKvStore(
	yarray: Y.Array<YKeyValueLwwEntry<unknown>>,
): KvStore {
	const ykv = new YKeyValueLww<unknown>(yarray);

	function get(key: string): unknown | undefined {
		return ykv.get(key);
	}

	function set(key: string, value: unknown): void {
		validateId(key, 'kv key');
		ykv.set(key, value);
	}

	function del(key: string): void {
		ykv.delete(key);
	}

	function has(key: string): boolean {
		return ykv.has(key);
	}

	function getAll(): Map<string, unknown> {
		const results = new Map<string, unknown>();
		for (const [key, entry] of ykv.map) {
			results.set(key, entry.val);
		}
		return results;
	}

	function observe(handler: ChangeHandler<unknown>): () => void {
		const ykvHandler = (
			changes: Map<
				string,
				import('../../core/utils/y-keyvalue-lww').YKeyValueLwwChange<unknown>
			>,
			transaction: Y.Transaction,
		) => {
			const events: ChangeEvent<unknown>[] = [];

			for (const [key, change] of changes) {
				if (change.action === 'add') {
					events.push({ type: 'add', key, value: change.newValue });
				} else if (change.action === 'update') {
					events.push({
						type: 'update',
						key,
						value: change.newValue,
						previousValue: change.oldValue,
					});
				} else if (change.action === 'delete') {
					events.push({ type: 'delete', key, previousValue: change.oldValue });
				}
			}

			if (events.length > 0) {
				handler(events, transaction);
			}
		};

		ykv.observe(ykvHandler);
		return () => ykv.unobserve(ykvHandler);
	}

	return {
		get,
		set,
		delete: del,
		has,
		getAll,
		observe,
	};
}
