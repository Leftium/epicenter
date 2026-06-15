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
	test('a table with no declaration has empty childDocLayouts', () => {
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		});
		expect(entries.childDocLayouts).toEqual({});
	});

	test('childDocs stores the declared layouts by name', () => {
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		}).childDocs({ content: body });
		expect(Object.keys(entries.childDocLayouts)).toEqual(['content']);
		expect(entries.childDocLayouts.content).toBe(body);
	});

	test('childDocs declares multiple bodies on one table', () => {
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		}).childDocs({ content: body, snippet: code });
		expect(entries.childDocLayouts.content).toBe(body);
		expect(entries.childDocLayouts.snippet).toBe(code);
	});

	test('childDocs rejects names that conflict with table methods at compile time', () => {
		const entries = defineTable({
			id: field.string(),
			title: field.string(),
		});
		if (false) {
			// @ts-expect-error child-doc fields are spread onto the table handle.
			entries.childDocs({ set: body });
		}
		expect(entries.childDocLayouts).toEqual({});
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
		expect(notes.childDocLayouts.content).toBe(body);
		expect(notes.versions.length).toBe(2);
		expect(notes.schema.properties.pinned).toBeDefined();
	});
});
