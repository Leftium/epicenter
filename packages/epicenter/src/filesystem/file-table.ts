import { type } from 'arktype';
import { defineTable } from '../static/define-table.js';
import { FileId } from './types.js';

export const filesTable = defineTable(
	type({
		id: FileId,
		name: 'string',
		parentId: FileId.or(type.null),
		type: "'file' | 'folder'",
		size: 'number',
		createdAt: 'number',
		updatedAt: 'number',
		trashedAt: 'number | null',
	}),
);
