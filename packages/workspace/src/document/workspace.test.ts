/**
 * createWorkspace tests: plaintext construction, identity agreement between
 * `id` and `ydoc.guid`, and cascade disposal via `using` syntax.
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { Type } from 'typebox';
import { defineKv } from './define-kv.js';
import { defineTable } from './define-table.js';
import { createWorkspace } from './workspace.js';

const notesDefinition = defineTable({
	id: field.string(),
	title: field.string(),
});

const sortOrderDefinition = defineKv(
	Type.Enum(['asc', 'desc']),
	() => 'asc' as const,
);

describe('createWorkspace', () => {
	test('plaintext construction reads and writes', () => {
		const workspace = createWorkspace({
			id: 'ws-plain',
			tables: { notes: notesDefinition },
			kv: { sortOrder: sortOrderDefinition },
		});

		workspace.tables.notes.set({ id: '1', title: 'hello' });
		expect(workspace.tables.notes.get('1').data).toEqual({
			id: '1',
			title: 'hello',
		});

		expect(workspace.kv.get('sortOrder')).toBe('asc');
		workspace.kv.set('sortOrder', 'desc');
		expect(workspace.kv.get('sortOrder')).toBe('desc');

		workspace[Symbol.dispose]();
	});

	test('legacy keyring option is ignored during construction', () => {
		const workspace = createWorkspace({
			id: 'ws-legacy-keyring',
			keyring: () => {
				throw new Error('keyring should not be read');
			},
			tables: { notes: notesDefinition },
			kv: { sortOrder: sortOrderDefinition },
		});

		workspace.tables.notes.set({ id: '1', title: 'plain' });
		expect(workspace.tables.notes.get('1').data).toEqual({
			id: '1',
			title: 'plain',
		});

		workspace.kv.set('sortOrder', 'desc');
		expect(workspace.kv.get('sortOrder')).toBe('desc');

		workspace[Symbol.dispose]();
	});

	test('workspace.ydoc.guid equals options.id', () => {
		const workspace = createWorkspace({
			id: 'ws-identity',
			tables: {},
			kv: {},
		});
		expect(workspace.ydoc.guid).toBe('ws-identity');
		workspace[Symbol.dispose]();
	});

	test('using-disposal destroys the underlying ydoc', () => {
		let destroyed = false;
		{
			using workspace = createWorkspace({
				id: 'ws-using',
				tables: { notes: notesDefinition },
				kv: {},
			});
			workspace.ydoc.once('destroy', () => {
				destroyed = true;
			});
		}
		expect(destroyed).toBe(true);
	});

	test('empty tables and empty kv are coherent', () => {
		const workspace = createWorkspace({
			id: 'ws-empty',
			tables: {},
			kv: {},
		});
		expect(workspace.ydoc.guid).toBe('ws-empty');
		expect(Object.keys(workspace.tables)).toEqual([]);
		workspace[Symbol.dispose]();
	});
});
