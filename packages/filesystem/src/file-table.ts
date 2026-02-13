import { type } from 'arktype';
import { defineTable } from '@epicenter/hq/static';
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
