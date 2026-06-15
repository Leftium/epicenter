/**
 * Owner derivations: every durable string for both modes.
 *
 * The point of these tests is to pin the wire formats. If any of these
 * strings change, every existing DO, R2 object, and owner-scoped local
 * database keyed on the old shape becomes orphaned. They are contracts.
 *
 * Personal mode and shared mode share the same shape; in personal mode
 * `ownerId` is the signed-in user's id, in shared mode it is the literal
 * `'shared'`.
 */

import { describe, expect, test } from 'bun:test';
import { asOwnerId, SHARED_OWNER_ID } from '@epicenter/identity';
import { assetKey, doName } from './owner.js';

const personal = asOwnerId('abc');
const shared = SHARED_OWNER_ID;

describe('doName', () => {
	test('personal partitions DO names under the user', () => {
		expect(doName(personal, 'r123')).toBe('owners/abc/rooms/r123');
	});
	test('shared partitions DO names under the literal shared owner', () => {
		expect(doName(shared, 'r123')).toBe('owners/shared/rooms/r123');
	});
});

describe('assetKey', () => {
	test('personal puts assets under the user partition', () => {
		expect(assetKey(personal, 'x1y2z3')).toBe('owners/abc/assets/x1y2z3');
	});
	test('shared puts assets under the shared partition', () => {
		expect(assetKey(shared, 'x1y2z3')).toBe('owners/shared/assets/x1y2z3');
	});
});
