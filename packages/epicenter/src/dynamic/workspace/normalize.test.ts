/**
 * Normalize Workspace Inputs Tests
 *
 * This file verifies `normalizeIcon` normalizes plain emoji values into the
 * tagged icon format while preserving already-tagged icon strings.
 * These checks ensure workspace definitions accept common icon inputs without
 * losing canonical storage format guarantees.
 *
 * Key behaviors:
 * - Converts plain emoji strings to `emoji:`-prefixed icon values
 * - Returns tagged icon strings and nullish inputs unchanged or normalized
 */

import { describe, expect, test } from 'bun:test';
import { type Icon, normalizeIcon } from '../schema/fields/types';

describe('normalizeIcon', () => {
	test('plain emoji string → Icon tagged string', () => {
		const result = normalizeIcon('📝');
		expect(result).toBe('emoji:📝');
	});

	test('plain emoji string with unicode → Icon tagged string', () => {
		const result = normalizeIcon('🚀');
		expect(result).toBe('emoji:🚀');
	});

	test('Icon tagged string input → unchanged', () => {
		const icon: Icon = 'emoji:📝';
		const result = normalizeIcon(icon);
		expect(result).toBe('emoji:📝');
	});

	test('lucide Icon input → unchanged', () => {
		const icon: Icon = 'lucide:file-text';
		const result = normalizeIcon(icon);
		expect(result).toBe('lucide:file-text');
	});

	test('url Icon input → unchanged', () => {
		const icon: Icon = 'url:https://example.com/icon.png';
		const result = normalizeIcon(icon);
		expect(result).toBe('url:https://example.com/icon.png');
	});

	test('null input → null', () => {
		expect(normalizeIcon(null)).toBeNull();
	});

	test('undefined input → null', () => {
		expect(normalizeIcon(undefined)).toBeNull();
	});
});
