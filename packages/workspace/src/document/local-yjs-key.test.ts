import { describe, expect, test } from 'bun:test';
import { createLocalYjsKey } from './local-yjs-key.js';

describe('createLocalYjsKey', () => {
	test('uses the owner-scoped local Yjs key shape', () => {
		expect(createLocalYjsKey('user-123', 'epicenter.fuji')).toBe(
			'epicenter:v1:user:user-123:yjs:epicenter.fuji',
		);
	});

	test('different users produce different local keys for the same Y.Doc', () => {
		expect(createLocalYjsKey('user-a', 'epicenter.fuji')).not.toBe(
			createLocalYjsKey('user-b', 'epicenter.fuji'),
		);
	});

	test('different Y.Doc GUIDs produce different local keys for the same user', () => {
		expect(createLocalYjsKey('user-a', 'epicenter.fuji')).not.toBe(
			createLocalYjsKey('user-a', 'epicenter.honeycrisp'),
		);
	});
});
