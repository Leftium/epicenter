/**
 * defineTable().childDocs Tests
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

describe('defineTable().childDocs', () => {
	test('a table with no declaration has empty childDocDecls', () => {
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		});
		expect(entries.childDocDecls).toEqual({});
	});

	test('childDocs stores the object form (layout + onLocalEdit) verbatim', () => {
		const onLocalEdit = () => ({ title: 'touched' });
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		}).childDocs({ content: { layout: body, onLocalEdit } });
		expect(entries.childDocDecls.content).toEqual({
			layout: body,
			onLocalEdit,
		});
	});

	test('childDocs stores the declared layouts by name', () => {
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		}).childDocs({ content: body });
		expect(Object.keys(entries.childDocDecls)).toEqual(['content']);
		expect(entries.childDocDecls.content).toBe(body);
	});

	test('childDocs declares multiple bodies on one table', () => {
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		}).childDocs({ content: body, snippet: code });
		expect(entries.childDocDecls.content).toBe(body);
		expect(entries.childDocDecls.snippet).toBe(code);
	});

	test('childDocs accepts any field name, including table method names', () => {
		// Field names live under the runtime `.docs` namespace, one level below the
		// table's CRUD methods, so a layout named `set` or `open` is fine: it can
		// never collide with `table.set`.
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		}).childDocs({ set: body, open: code });
		expect(entries.childDocDecls.set).toBe(body);
		expect(entries.childDocDecls.open).toBe(code);
	});

	test('childDocs preserves the schema and versions', () => {
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		}).childDocs({ content: body });
		expect(entries.versions.length).toBe(1);
		expect(entries.schema.properties.title).toBeDefined();
	});

	test('childDocs composes after migrate on multi-version tables', () => {
		const notes = defineTable(
			{ id: field.string(), title: field.string() },
			{ id: field.string(), title: field.string(), pinned: field.boolean() },
		)
			.migrate(({ value, version }) =>
				version === 1 ? { ...value, pinned: false } : value,
			)
			.childDocs({ content: body });
		expect(notes.childDocDecls.content).toBe(body);
		expect(notes.versions.length).toBe(2);
		expect(notes.schema.properties.pinned).toBeDefined();
	});
});
