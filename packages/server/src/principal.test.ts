/**
 * Historical principal authority naming tests.
 *
 * These literals pin the retained generation-specific namespace helper for
 * user and instance principals. Current store authorities use application and
 * scope addresses, covered by the mounted store route tests.
 */

import { describe, expect, test } from 'bun:test';
import { asPrincipalId, INSTANCE_PRINCIPAL_ID } from '@epicenter/principal';
import { storeAuthorityName } from './principal.js';

const userPrincipal = asPrincipalId('abc');
const instance = INSTANCE_PRINCIPAL_ID;

describe('storeAuthorityName', () => {
	test('the resource segment is data, a sibling of blobs (ADR-0276)', () => {
		expect(
			storeAuthorityName(userPrincipal, 'so.epicenter.honeycrisp', 3),
		).toBe('principals/abc/data/so.epicenter.honeycrisp/generations/3');
	});

	test('an instance addresses one authority under the literal instance principal', () => {
		expect(storeAuthorityName(instance, 'so.epicenter.honeycrisp', 1)).toBe(
			'principals/instance/data/so.epicenter.honeycrisp/generations/1',
		);
	});

	test('two generations of one database are two objects (ADR-0292)', () => {
		// The whole of membership. A replica addressed at generation 3 cannot
		// reach generation 4's bytes however its dial is written, which is what
		// retired the document identity stamp.
		expect(
			storeAuthorityName(userPrincipal, 'so.epicenter.honeycrisp', 3),
		).not.toBe(storeAuthorityName(userPrincipal, 'so.epicenter.honeycrisp', 4));
	});
});
