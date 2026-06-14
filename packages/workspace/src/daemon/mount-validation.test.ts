/**
 * Pins `isValidMountName`, the mount-name format rule.
 *
 * A mount name becomes `/list` manifest keys and daemon action paths
 * (`${mount}.${action}`) and, under the Epicenter-folder layout, the name of a
 * generated folder that is a direct child of the Epicenter root. So the pattern
 * has to reject anything that would collide with a reserved sibling
 * (`.epicenter`, `epicenter.config.ts`), escape the root (`..`, `a/b`), or land
 * a dangerous object key (`__proto__`). These tests lock that in so a loosened
 * regex fails loudly here. `loadEpicenterConfig` owns the call site and points
 * a bad name at the offending file.
 */

import { describe, expect, test } from 'bun:test';
import { isValidMountName } from './mount-validation.js';

describe('isValidMountName', () => {
	test('accepts plain alphanumeric and dash/underscore names', () => {
		for (const name of [
			'fuji',
			'honeycrisp',
			'tab-manager',
			'note_1',
			'A1',
			'0',
		]) {
			expect(isValidMountName(name)).toBe(true);
		}
	});

	// Each of these would collide with a reserved sibling, escape the Epicenter
	// root, or land a dangerous object key as a generated folder name.
	const invalidNames = [
		'.epicenter',
		'epicenter.config.ts',
		'..',
		'.',
		'a/b',
		'a\\b',
		'__proto__',
		'-leading',
		'_leading',
		'foo.bar',
		'has space',
		'',
	];
	for (const name of invalidNames) {
		test(`rejects ${JSON.stringify(name)} as invalid`, () => {
			expect(isValidMountName(name)).toBe(false);
		});
	}
});
