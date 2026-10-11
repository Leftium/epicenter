/**
 * Merge Marker Tests
 *
 * `conflictMarkers` and `mergeLines` split lines at line feeds and keep
 * every character, so a lone carriage return, U+2028, and U+2029 stay in
 * their line. For text with only LF and CRLF breaks, the lines are the ones
 * isomorphic-git's merge uses, so the markers are unchanged.
 */
import { expect, test } from 'bun:test';
import { conflictMarkers, mergeLines } from './merge-markers.js';

const labels = { ours: 'HEAD', theirs: 'origin/main' };

test('markers for LF and CRLF text, with and without a last line break', async () => {
	expect(
		await conflictMarkers(
			{ base: 'a\r\nb\r\nc', ours: 'a\r\nB\r\nc', theirs: 'a\r\nb2\r\nc' },
			labels,
		),
	).toBe('a\r\n<<<<<<< HEAD\nB\r\n=======\nb2\r\n>>>>>>> origin/main\nc');
	expect(
		await conflictMarkers(
			{ base: 'a\n', ours: 'a\nx', theirs: 'a\ny' },
			labels,
		),
	).toBe('a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> origin/main\n');
	expect(
		await conflictMarkers({ base: '', ours: '\n\n', theirs: 'x\n' }, labels),
	).toBe('<<<<<<< HEAD\n\n\n=======\nx\n>>>>>>> origin/main\n');
});

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
