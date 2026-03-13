/**
 * createKv Tests
 *
 * Verifies key-value helpers over Y.Doc for set/get/delete behavior and migration-on-read.
 * These tests protect the core KV contract used by workspace settings and metadata.
 *
 * Key behaviors:
 * - `get` returns typed values directly (stored value or default).
 * - Versioned KV definitions migrate old values when read.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import type { YKeyValueLwwEntry } from '../shared/y-keyvalue/y-keyvalue-lww.js';
import { createKv } from './create-kv.js';
import { defineKv } from './define-kv.js';

describe('createKv', () => {
	test('set stores a value that get returns', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			theme: defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' }),
		});

		kv.set('theme', { mode: 'dark' });
		expect(kv.get('theme')).toEqual({ mode: 'dark' });
	});

	test('get returns defaultValue for unset key', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			theme: defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' }),
		});

		expect(kv.get('theme')).toEqual({ mode: 'light' });
	});

	test('delete causes get to return defaultValue', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			theme: defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' }),
		});

		kv.set('theme', { mode: 'dark' });
		expect(kv.get('theme')).toEqual({ mode: 'dark' });

		kv.delete('theme');
		expect(kv.get('theme')).toEqual({ mode: 'light' });
	});

	test('migrates old data on read', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			theme: defineKv(
				type({ mode: "'light' | 'dark'" }),
				type({ mode: "'light' | 'dark'", fontSize: 'number' }),
			).migrate(
				(v) => {
					if (!('fontSize' in v)) return { ...v, fontSize: 14 };
					return v;
				},
				{ mode: 'light', fontSize: 14 },
			),
		});

		// Simulate old data
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('kv');
		yarray.push([{ key: 'theme', val: { mode: 'dark' }, ts: 0 }]);

		// Read should migrate
		const value = kv.get('theme');
		expect(value.fontSize).toBe(14);
	});

	test('get returns defaultValue for invalid stored data', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			count: defineKv(type('number'), 0),
		});

		// Write garbage directly to the Y.Array
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('kv');
		yarray.push([{ key: 'count', val: 'not-a-number', ts: 0 }]);

		expect(kv.get('count')).toBe(0);
	});
});
