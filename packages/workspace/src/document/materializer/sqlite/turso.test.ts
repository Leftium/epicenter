/**
 * Integration test for `attachTursoMaterializer`.
 *
 * Boots a real Y.Doc, attaches the Turso-backed materializer at `:memory:`,
 * seeds rows, and reads them back through Turso's prepared-statement API.
 * Exercises the full pipeline (Y.Doc observer -> DDL -> INSERT -> SELECT)
 * against the Turso Rust engine.
 */

import { describe, expect, test } from 'bun:test';
import Type from 'typebox';
import { column, createWorkspace, defineTable } from '../../../index.js';
import { attachTursoMaterializer } from './turso.js';

const entriesTable = defineTable({
	id: column.string(),
	title: column.string(),
	body: column.nullable(column.string()),
	priority: column.enum(['low', 'medium', 'high']),
	tags: column.json(Type.Array(Type.String())),
});

describe('attachTursoMaterializer', () => {
	test('materializes Y.Doc rows into a Turso :memory: mirror', async () => {
		using workspace = createWorkspace({
			id: 'turso-test',
			tables: { entries: entriesTable },
			kv: {},
		});

		// Seed BEFORE attach so whenFlushed includes the full-load. Avoids the
		// "wait for the async sync queue to drain" pattern that's only
		// deterministic against sync drivers.
		workspace.tables.entries.set({
			id: 'a',
			title: 'Alpha',
			body: 'first entry',
			priority: 'high',
			tags: ['urgent'],
		});
		workspace.tables.entries.set({
			id: 'b',
			title: 'Beta',
			body: null,
			priority: 'low',
			tags: [],
		});

		const materializer = attachTursoMaterializer(workspace, {
			path: ':memory:',
		});

		await materializer.whenFlushed;

		const client = await materializer.client;
		const rows = (await client
			.prepare(
				'SELECT id, title, body, priority, tags FROM entries ORDER BY id',
			)
			.all()) as Array<{
			id: string;
			title: string;
			body: string | null;
			priority: string;
			tags: string;
		}>;

		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({
			id: 'a',
			title: 'Alpha',
			body: 'first entry',
			priority: 'high',
			tags: JSON.stringify(['urgent']),
		});
		expect(rows[1]).toEqual({
			id: 'b',
			title: 'Beta',
			body: null,
			priority: 'low',
			tags: JSON.stringify([]),
		});
	});
});
