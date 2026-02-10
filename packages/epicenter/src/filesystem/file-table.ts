import { type } from 'arktype';
import { defineTable } from '../static/define-table.js';

export const filesTable = defineTable(
	type({
		id: 'string',
		name: 'string',
		'parentId': 'string | null',
		type: "'file' | 'folder'",
		size: 'number',
		createdAt: 'number',
		updatedAt: 'number',
		'trashedAt': 'number | null',
	}),
);
