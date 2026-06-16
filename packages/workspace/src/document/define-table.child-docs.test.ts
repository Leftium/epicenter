/**
 * defineTable().docs Tests
 *
 * Verifies the child-doc declaration builder: a table may declare one or more
 * collaborative bodies by name, the layouts are stored verbatim for the runtime
 * binding to read, and the step composes after `.migrate()` on multi-version
 * tables without disturbing versions or schema.
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import type * as Y from 'yjs';
import { defineTable } from './define-table.js';

const body = (ydoc: Y.Doc) => ({ text: ydoc.getText('body') });
const code = (ydoc: Y.Doc) => ({ text: ydoc.getText('code') });

describe('defineTable().docs', () => {
	test('a table with no declaration has empty docDecls', () => {
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		});
		expect(entries.docDecls).toEqual({});
	});

	test('docs stores the object form (layout + onLocalEdit) verbatim', () => {
		const onLocalEdit = () => ({ title: 'touched' });
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		}).docs({ content: { layout: body, onLocalEdit } });
		expect(entries.docDecls.content).toEqual({
			layout: body,
			onLocalEdit,
		});
	});

	test('docs stores the declared layouts by name', () => {
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		}).docs({ content: body });
		expect(Object.keys(entries.docDecls)).toEqual(['content']);
		expect(entries.docDecls.content).toBe(body);
	});

	test('docs declares multiple bodies on one table', () => {
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		}).docs({ content: body, snippet: code });
		expect(entries.docDecls.content).toBe(body);
		expect(entries.docDecls.snippet).toBe(code);
	});

	test('docs accepts any field name, including table method names', () => {
		// Field names live under the runtime `.docs` namespace, one level below the
		// table's CRUD methods, so a layout named `set` or `open` is fine: it can
		// never collide with `table.set`.
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		}).docs({ set: body, open: code });
		expect(entries.docDecls.set).toBe(body);
		expect(entries.docDecls.open).toBe(code);
	});

	test('docs preserves the schema and versions', () => {
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		}).docs({ content: body });
		expect(entries.versions.length).toBe(1);
		expect(entries.schema.properties.title).toBeDefined();
	});

	test('docs composes after migrate on multi-version tables', () => {
		const notes = defineTable(
			{ id: field.string(), title: field.string() },
			{ id: field.string(), title: field.string(), pinned: field.boolean() },
		)
			.migrate(({ value, version }) =>
				version === 1 ? { ...value, pinned: false } : value,
			)
			.docs({ content: body });
		expect(notes.docDecls.content).toBe(body);
		expect(notes.versions.length).toBe(2);
		expect(notes.schema.properties.pinned).toBeDefined();
	});
});
