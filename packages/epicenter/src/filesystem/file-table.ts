import { type } from 'arktype';
import { defineTable } from '../static/define-table.js';
import { fileIdSchema } from './types.js';

export const filesTable = defineTable(
	type({
		id: fileIdSchema,
		name: 'string',
		parentId: fileIdSchema.or(type.null),
		type: "'file' | 'folder'",
		size: 'number',
		createdAt: 'number',
		updatedAt: 'number',
		trashedAt: 'number | null',
	}),
);
