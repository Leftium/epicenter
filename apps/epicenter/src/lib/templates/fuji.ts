/**
 * Fuji workspace template.
 *
 * A minimal, timeline-first note-taking schema with no folders.
 * Entries flow chronologically with DateTimeString timestamps,
 * branded EntryId, and Y.Text collaborative rich-text bodies.
 */

import {
	DateTimeString,
	defineKv,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

type EntryId = string & Brand<'EntryId'>;
const EntryId = type('string').pipe((s): EntryId => s as EntryId);

const entries = defineTable(
	type({
		id: EntryId,
		title: 'string',
		preview: 'string',
		pinned: 'boolean',
		createdAt: DateTimeString,
		updatedAt: DateTimeString,
		_v: '1',
	}),
).withDocument('body', { guid: 'id' });

export const fujiWorkspace = defineWorkspace({
	id: 'epicenter.fuji' as const,
	tables: { entries },
	kv: {
		selectedEntryId: defineKv(EntryId.or(type('null'))),
		sortBy: defineKv(type("'dateEdited' | 'dateCreated'")),
	},
});

export const FUJI_TEMPLATE = {
	id: 'epicenter.fuji',
	name: 'Fuji',
	description: 'Quick-capture timeline notes — no folders, just write',
	icon: null,
	workspace: fujiWorkspace,
} as const;
