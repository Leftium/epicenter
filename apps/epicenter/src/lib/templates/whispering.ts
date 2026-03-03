/**
 * Whispering workspace template.
 *
 * Mirrors the core recording schema used by Epicenter Whispering so that
 * recordings and transcriptions can be shared across apps via a unified
 * Epicenter workspace.
 */

import { defineTable, defineWorkspace } from '@epicenter/workspace';
import { type } from 'arktype';

const recordings = defineTable(
	type({
		id: 'string',
		title: 'string',
		subtitle: 'string',
		timestamp: 'string',
		createdAt: 'string',
		updatedAt: 'string',
		transcribedText: 'string',
		transcriptionStatus: "'UNPROCESSED' | 'TRANSCRIBING' | 'DONE' | 'FAILED'",
		_v: '1',
	}),
);

export const whisperingWorkspace = defineWorkspace({
	id: 'epicenter.whispering' as const,
	tables: { recordings },
});

export const WHISPERING_TEMPLATE = {
	id: 'epicenter.whispering',
	name: 'Whispering',
	description: '',
	icon: null,
	workspace: whisperingWorkspace,
} as const;
