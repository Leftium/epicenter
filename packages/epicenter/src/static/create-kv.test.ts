/**
 * createKv Tests
 *
 * Verifies key-value helpers over Y.Doc for set/get/delete behavior and migration-on-read.
 * These tests protect the core KV contract used by workspace settings and metadata.
 *
 * Key behaviors:
 * - `set` and `get` return typed value results with correct status states.
 * - Versioned KV definitions migrate old values when read.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import type { YKeyValueLwwEntry } from '../shared/y-keyvalue/y-keyvalue-lww.js';
import { createKv } from './create-kv.js';
import { defineKv } from './define-kv.js';

describe('createKv', () => {
	test('set stores a value that get returns as valid', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			theme: defineKv(type({ mode: "'light' | 'dark'" })),
		});

		kv.set('theme', { mode: 'dark' });

		const result = kv.get('theme');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.value).toEqual({ mode: 'dark' });
		}
	});

	test('get returns not_found for unset key', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			theme: defineKv(type({ mode: "'light' | 'dark'" })),
		});

		const result = kv.get('theme');
		expect(result.status).toBe('not_found');
	});

	test('delete removes the value', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			theme: defineKv(type({ mode: "'light' | 'dark'" })),
		});

		kv.set('theme', { mode: 'dark' });
		expect(kv.get('theme').status).toBe('valid');

		kv.delete('theme');
		expect(kv.get('theme').status).toBe('not_found');
	});

	test('migrates old data on read', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			theme: defineKv()
				.version(type({ mode: "'light' | 'dark'" }))
				.version(type({ mode: "'light' | 'dark'", fontSize: 'number' }))
				.migrate((v) => {
					if (!('fontSize' in v)) return { ...v, fontSize: 14 };
					return v;
				}),
		});

		// Simulate old data
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('kv');
		yarray.push([{ key: 'theme', val: { mode: 'dark' }, ts: 0 }]);

		// Read should migrate
		const result = kv.get('theme');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.value.fontSize).toBe(14);
		}
	});
});
