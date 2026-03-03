/**
 * Entries workspace template.
 *
 * A general-purpose content management schema with:
 * - id: unique identifier
 * - title: entry title
 * - content: entry body text
 * - type: categorization (string)
 * - tags: additional tagging (string)
 */

import { defineTable, defineWorkspace } from '@epicenter/workspace';
import { type } from 'arktype';

const entries = defineTable(
	type({
		id: 'string',
		title: 'string',
		content: 'string',
		type: 'string',
		tags: 'string',
		_v: '1',
	}),
);

export const entriesWorkspace = defineWorkspace({
	id: 'epicenter.entries' as const,
	tables: { entries },
});

export const ENTRIES_TEMPLATE = {
	id: 'epicenter.entries',
	name: 'Entries',
	description: '',
	icon: null,
	workspace: entriesWorkspace,
} as const;
