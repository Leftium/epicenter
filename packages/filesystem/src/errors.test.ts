/**
 * Error Factory Tests
 *
 * Covers errno-style error creation with code properties.
 */

import { describe, expect, test } from 'bun:test';
import { FS_ERRORS } from './errors.js';

describe('FS_ERRORS', () => {
	test('creates error with code property', () => {
		const err = FS_ERRORS.ENOENT('/missing.txt');
		expect(err.message).toBe('ENOENT: /missing.txt');
		expect(err.code).toBe('ENOENT');
		expect(err).toBeInstanceOf(Error);
	});
});
