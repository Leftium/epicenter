/**
 * Honeycrisp workspace template.
 *
 * An Apple Notes clone with three-column layout: sidebar folders,
 * note list, and Tiptap rich-text editor. Notes have Y.Text collaborative
 * bodies and can be organized into folders with optional emoji icons.
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

type NoteId = string & Brand<'NoteId'>;
const NoteId = type('string').pipe((s): NoteId => s as NoteId);

type FolderId = string & Brand<'FolderId'>;
const FolderId = type('string').pipe((s): FolderId => s as FolderId);

const folders = defineTable(
	type({
		id: FolderId,
		name: 'string',
		'icon?': 'string | undefined',
		sortOrder: 'number',
		_v: '1',
	}),
);

const notes = defineTable(
	type({
		id: NoteId,
		'folderId?': FolderId.or('undefined'),
		title: 'string',
		preview: 'string',
		pinned: 'boolean',
		createdAt: DateTimeString,
		updatedAt: DateTimeString,
		_v: '1',
	}),
).withDocument('body', {
	guid: 'id',
	onUpdate: () => ({ updatedAt: dateTimeStringNow() }),
});

export const honeycrisp = defineWorkspace({
	id: 'epicenter.honeycrisp' as const,
	tables: { folders, notes },
	kv: {
		selectedFolderId: defineKv(FolderId.or(type('null'))),
		selectedNoteId: defineKv(NoteId.or(type('null'))),
		sortBy: defineKv(type("'dateEdited' | 'dateCreated' | 'title'")),
		sidebarCollapsed: defineKv(type('boolean')),
	},
});

export const HONEYCRISP_TEMPLATE = {
	id: 'epicenter.honeycrisp',
	name: 'Honeycrisp',
	description: 'Apple Notes clone — folders, pinned notes, rich text editing',
	icon: null,
	workspace: honeycrisp,
} as const;
