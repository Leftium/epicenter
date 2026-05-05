import { describe, expect, test } from 'bun:test';
import { clearLocalYjsDataForUser } from './clear-local-yjs-data.js';

describe('clearLocalYjsDataForUser', () => {
	test('clears known scoped document keys when database enumeration is unavailable', async () => {
		const cleared: string[] = [];

		await clearLocalYjsDataForUser({
			userId: 'user-1',
			ydocGuids: ['doc-a', 'doc-b'],
			indexedDB: undefined,
			clearDocument: async (name) => {
				cleared.push(name);
			},
		});

		expect(cleared).toEqual([
			'epicenter:v1:user:user-1:yjs:doc-a',
			'epicenter:v1:user:user-1:yjs:doc-b',
		]);
	});

	test('also clears enumerated scoped database names', async () => {
		const cleared: string[] = [];

		await clearLocalYjsDataForUser({
			userId: 'user-1',
			ydocGuids: ['doc-a'],
			indexedDB: {
				databases: async () => [
					{ name: 'epicenter:v1:user:user-1:yjs:doc-b' },
					{ name: 'epicenter:v1:user:user-2:yjs:doc-c' },
					{ name: 'unscoped-doc' },
					{},
				],
			} as IDBFactory,
			clearDocument: async (name) => {
				cleared.push(name);
			},
		});

		expect(cleared.toSorted()).toEqual([
			'epicenter:v1:user:user-1:yjs:doc-a',
			'epicenter:v1:user:user-1:yjs:doc-b',
		]);
	});
});
