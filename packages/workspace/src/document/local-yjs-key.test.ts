import { describe, expect, test } from 'bun:test';
import { asOwnerId } from '@epicenter/auth';
import { createOwnedYjsKey, getOwnedYjsPrefix } from './local-yjs-key.js';

const SERVER = 'api.epicenter.so';
const ALICE = asOwnerId('user-a');
const BOB = asOwnerId('user-b');
const TEAM = asOwnerId('team');

describe('getOwnedYjsPrefix', () => {
	test('personal mode owner id partitions the prefix under owners/', () => {
		expect(getOwnedYjsPrefix(SERVER, ALICE)).toBe(
			'epicenter/api.epicenter.so/owners/user-a/',
		);
	});
	test("team mode uses the literal 'team' owner id under the same owners/ partition", () => {
		expect(getOwnedYjsPrefix(SERVER, TEAM)).toBe(
			'epicenter/api.epicenter.so/owners/team/',
		);
	});
});

describe('createOwnedYjsKey', () => {
	test('appends the ydoc guid to the owner prefix', () => {
		expect(createOwnedYjsKey(SERVER, ALICE, 'epicenter.fuji')).toBe(
			'epicenter/api.epicenter.so/owners/user-a/epicenter.fuji',
		);
		expect(createOwnedYjsKey(SERVER, TEAM, 'epicenter.fuji')).toBe(
			'epicenter/api.epicenter.so/owners/team/epicenter.fuji',
		);
	});
	test('different owners on the same server produce different keys', () => {
		expect(createOwnedYjsKey(SERVER, ALICE, 'epicenter.fuji')).not.toBe(
			createOwnedYjsKey(SERVER, BOB, 'epicenter.fuji'),
		);
	});
	test('different ydoc guids produce different keys for the same owner', () => {
		expect(createOwnedYjsKey(SERVER, ALICE, 'epicenter.fuji')).not.toBe(
			createOwnedYjsKey(SERVER, ALICE, 'epicenter.honeycrisp'),
		);
	});
	test('different servers produce different keys for the same team owner id', () => {
		expect(createOwnedYjsKey('team-a.example', TEAM, 'd')).not.toBe(
			createOwnedYjsKey('team-b.example', TEAM, 'd'),
		);
	});
});
