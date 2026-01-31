/**
 * KV Store for Dynamic Workspace
 *
 * Stores workspace-level key-value pairs in Y.Doc using YKeyValueLww.
 * Validates values on read against KV field definitions.
 *
 * @packageDocumentation
 */

import { type TProperties, type TSchema, Type } from 'typebox';
import { Compile, type Validator } from 'typebox/compile';
import type * as Y from 'yjs';
import type { KvField } from '../../core/schema/fields/types';
import {
	YKeyValueLww,
	type YKeyValueLwwChange,
	type YKeyValueLwwEntry,
} from '../../core/utils/y-keyvalue-lww';
import { validateId } from '../keys';
import type {
	ChangeEvent,
	ChangeHandler,
	InvalidKvResult,
	KvGetResult,
	KvResult,
	KvStore,
	ValidationError,
} from '../types.js';

/**
 * Y.Array name for KV store.
 */
export const KV_ARRAY_NAME = 'kv';

/**
 * Prefix for table Y.Array names.
 * Tables are stored as `table:{tableId}` to avoid collisions with reserved names.
 */
export const TABLE_ARRAY_PREFIX = 'table:';

/** Convert a KvField to its TypeBox schema. */
function fieldToTypebox(field: KvField): TSchema {
	switch (field.type) {
		case 'text':
		case 'richtext':
		case 'date':
			return Type.String();
		case 'integer':
			return Type.Integer();
		case 'real':
			return Type.Number();
		case 'boolean':
			return Type.Boolean();
		case 'select':
			return Type.Union(field.options.map((v) => Type.Literal(v)));
		case 'tags': {
			const opts = field.options;
			if (opts?.length)
				return Type.Array(Type.Union(opts.map((v) => Type.Literal(v))));
			return Type.Array(Type.String());
		}
		case 'json':
			return Type.Unknown();
	}
}

/**
 * Create a KV store backed by YKeyValueLww with validation.
 *
 * @param yarray - The Y.Array for KV data
 * @param kvFields - Optional KV field definitions for validation
 */
export function createKvStore(
	yarray: Y.Array<YKeyValueLwwEntry<unknown>>,
	kvFields: readonly KvField[] = [],
): KvStore {
	const ykv = new YKeyValueLww<unknown>(yarray);

	// Build validators for each KV field, keyed by field ID
	const validators = new Map<string, Validator<TProperties, TSchema>>();
	for (const field of kvFields) {
		validators.set(field.id, Compile(fieldToTypebox(field)));
	}

	/**
	 * Validate a value against its field definition.
	 */
	function validateValue(key: string, value: unknown): KvGetResult<unknown> {
		const validator = validators.get(key);

		// Fields not in schema pass validation (advisory behavior)
		if (!validator) {
			return { status: 'valid', value };
		}

		// Validate the value
		if (validator.Check(value)) {
			return { status: 'valid', value };
		}

		const errors: ValidationError[] = [...validator.Errors(value)];
		return { status: 'invalid', key, errors, value };
	}

	return {
		get(key: string): KvGetResult<unknown> {
			const value = ykv.get(key);

			// Check if key exists
			if (value === undefined && !ykv.has(key)) {
				return { status: 'not_found', key, value: undefined };
			}

			return validateValue(key, value);
		},

		getRaw(key: string): unknown | undefined {
			return ykv.get(key);
		},

		set(key: string, value: unknown): void {
			validateId(key, 'kv key');
			ykv.set(key, value);
		},

		delete(key: string): void {
			ykv.delete(key);
		},

		has(key: string): boolean {
			return ykv.has(key);
		},

		getAll(): KvResult<unknown>[] {
			const results: KvResult<unknown>[] = [];
			for (const [key, entry] of ykv.map) {
				const result = validateValue(key, entry.val);
				// getAll only returns existing entries, so filter out not_found
				if (result.status !== 'not_found') {
					results.push(result);
				}
			}
			return results;
		},

		getAllValid(): Map<string, unknown> {
			const results = new Map<string, unknown>();
			for (const [key, entry] of ykv.map) {
				const result = validateValue(key, entry.val);
				if (result.status === 'valid') {
					results.set(key, result.value);
				}
			}
			return results;
		},

		getAllInvalid(): InvalidKvResult[] {
			const results: InvalidKvResult[] = [];
			for (const [key, entry] of ykv.map) {
				const result = validateValue(key, entry.val);
				if (result.status === 'invalid') {
					results.push(result);
				}
			}
			return results;
		},

		observe(handler: ChangeHandler<unknown>): () => void {
			const ykvHandler = (
				changes: Map<string, YKeyValueLwwChange<unknown>>,
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
						events.push({
							type: 'delete',
							key,
							previousValue: change.oldValue,
						});
					}
				}

				if (events.length > 0) {
					handler(events, transaction);
				}
			};

			ykv.observe(ykvHandler);
			return () => ykv.unobserve(ykvHandler);
		},
	};
}
