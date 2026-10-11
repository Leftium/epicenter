/**
 * Line Merge Tests
 *
 * `mergeLines` splits lines at line feeds and keeps every character, so a
 * lone carriage return, U+2028, and U+2029 stay in their line; lines both
 * sides changed differently make the whole merge `undefined`.
 */
import { expect, test } from 'bun:test';
import { mergeLines } from './merge-lines.js';

test('a line merge keeps lone carriage returns and Unicode line separators', async () => {
	expect(
		await mergeLines({
			base: 'x\u2028y\nmid\nz\n',
			ours: 'X\u2028y\nmid\nz\n',
			theirs: 'x\u2028y\nmid\nZ\n',
		}),
	).toBe('X\u2028y\nmid\nZ\n');
	expect(
		await mergeLines({
			base: 'x\ry\nmid\nz',
			ours: 'x\ry\nmid\nZ',
			theirs: 'X\ry\nmid\nz',
		}),
	).toBe('X\ry\nmid\nZ');
	expect(
		await mergeLines({ base: 'a\nb\n', ours: 'A\nb\n', theirs: 'a2\nb\n' }),
	).toBeUndefined();
});
