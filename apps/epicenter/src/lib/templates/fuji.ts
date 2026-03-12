/**
 * Fuji workspace template.
 *
 * A personal CMS schema for content pieces—articles, thoughts, ideas—organized
 * by type and tags. Entries have Y.Text collaborative rich-text bodies, explicit
 * titles, and auto-derived previews. Displayed in a data table with an editor
 * panel.
 */

import {
	DateTimeString,
	dateTimeStringNow,
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
		'type?': 'string[] | undefined',
		'tags?': 'string[] | undefined',
		createdAt: DateTimeString,
		updatedAt: DateTimeString,
		_v: '2',
	}),
).withDocument('body', {
	guid: 'id',
	onUpdate: () => ({ updatedAt: dateTimeStringNow() }),
});

export const fujiWorkspace = defineWorkspace({
	id: 'epicenter.fuji' as const,
	tables: { entries },
	kv: {
		selectedEntryId: defineKv(EntryId.or(type('null'))),
		viewMode: defineKv(type("'table' | 'timeline'")),
		sidebarCollapsed: defineKv(type('boolean')),
	},
});

export const FUJI_TEMPLATE = {
	id: 'epicenter.fuji',
	name: 'Fuji',
	description:
		'Personal content app — articles, thoughts, ideas with tags and types',
	icon: null,
	workspace: fujiWorkspace,
} as const;
