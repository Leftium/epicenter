/**
 * Owner derivations: every durable string for both modes.
 *
 * The point of these tests is to pin the wire formats. If any of these
 * strings change, every existing DO, R2 object, and locally-encrypted
 * blob keyed on the old shape becomes orphaned. They are contracts.
 */

import type { Owner } from '@epicenter/auth';
import { describe, expect, test } from 'bun:test';
import { assetKey, doName, ownerPath } from './owner.js';

const personal: Owner = { kind: 'personal', userId: 'abc' };
const team: Owner = { kind: 'team' };

describe('ownerPath', () => {
	test('personal returns users/<userId>', () => {
		expect(ownerPath(personal)).toBe('users/abc');
	});
	test('team returns empty string', () => {
		expect(ownerPath(team)).toBe('');
	});
});

describe('doName', () => {
	test('personal partitions DO names under the user', () => {
		expect(doName(personal, 'r123')).toBe('users/abc/rooms/r123');
	});
	test('team mounts DO names at the resource type', () => {
		expect(doName(team, 'r123')).toBe('rooms/r123');
	});
});

describe('assetKey', () => {
	test('personal puts assets under the user partition', () => {
		expect(assetKey(personal, 'x1y2z3')).toBe('users/abc/assets/x1y2z3');
	});
	test('team places assets at the resource type root', () => {
		expect(assetKey(team, 'x1y2z3')).toBe('assets/x1y2z3');
	});
});

describe('cross-mode isolation', () => {
	test('two distinct personal users never collide on any resource', () => {
		const alice: Owner = { kind: 'personal', userId: 'alice' };
		const bob: Owner = { kind: 'personal', userId: 'bob' };
		expect(doName(alice, 'r')).not.toBe(doName(bob, 'r'));
		expect(assetKey(alice, 'a')).not.toBe(assetKey(bob, 'a'));
	});
	test('team and personal never produce overlapping strings', () => {
		expect(doName(team, 'r')).not.toBe(doName(personal, 'r'));
		expect(assetKey(team, 'a')).not.toBe(assetKey(personal, 'a'));
	});
});
