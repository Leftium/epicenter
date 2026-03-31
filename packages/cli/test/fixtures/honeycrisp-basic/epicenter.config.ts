/**
 * Honeycrisp workspace client — e2e test fixture.
 *
 * Mirrors the schema from apps/honeycrisp/src/lib/workspace.ts but
 * inlined here so the test has zero cross-app dependencies.
 *
 * This is exactly what a user would get after `epicenter install honeycrisp`:
 * a standalone epicenter.config.ts with a workspace client.
 */

import {
	DateTimeString,
	createWorkspace,
	defineKv,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';
import { type } from 'arktype';

const foldersTable = defineTable(
	type({
		id: 'string',
		name: 'string',
		'icon?': 'string | undefined',
		sortOrder: 'number',
		_v: '1',
	}),
);

const notesTable = defineTable(
	type({
		id: 'string',
		'folderId?': 'string | undefined',
		title: 'string',
		preview: 'string',
		pinned: 'boolean',
		'deletedAt?': 'string | undefined',
		'wordCount?': 'number | undefined',
		createdAt: DateTimeString,
		updatedAt: DateTimeString,
		_v: '2',
	}),
);

const definition = defineWorkspace({
	id: 'epicenter.honeycrisp',
	tables: { folders: foldersTable, notes: notesTable },
	kv: {
		selectedFolderId: defineKv(type('string | null'), null),
		selectedNoteId: defineKv(type('string | null'), null),
		sortBy: defineKv(
			type("'dateEdited' | 'dateCreated' | 'title'"),
			'dateEdited',
		),
		sidebarCollapsed: defineKv(type('boolean'), false),
	},
});
export { definition };

export default createWorkspace(definition);
