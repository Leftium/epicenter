import { describe, expect, test } from 'bun:test';
import { asOwnerId, SHARED_OWNER_ID } from '@epicenter/identity';
import { createOwnedYjsKey, getOwnedYjsPrefix } from './local-yjs-key.js';

const SERVER = 'api.epicenter.so';
const ALICE = asOwnerId('user-a');
const SHARED = SHARED_OWNER_ID;

describe('getOwnedYjsPrefix', () => {
	test('personal mode owner id partitions the prefix under owners/', () => {
		expect(getOwnedYjsPrefix(SERVER, ALICE)).toBe(
			'epicenter/api.epicenter.so/owners/user-a/',
		);
	});
	test("shared mode uses the literal 'shared' owner id under the same owners/ partition", () => {
		expect(getOwnedYjsPrefix(SERVER, SHARED)).toBe(
			'epicenter/api.epicenter.so/owners/shared/',
		);
	});
});

describe('createOwnedYjsKey', () => {
	test('appends the ydoc guid to the owner prefix', () => {
		expect(createOwnedYjsKey(SERVER, ALICE, 'epicenter-fuji')).toBe(
			'epicenter/api.epicenter.so/owners/user-a/epicenter-fuji',
		);
		expect(createOwnedYjsKey(SERVER, SHARED, 'epicenter-fuji')).toBe(
			'epicenter/api.epicenter.so/owners/shared/epicenter-fuji',
		);
	});
});
