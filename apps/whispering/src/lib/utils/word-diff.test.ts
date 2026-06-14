import { expect, test } from 'bun:test';
import { wordDiff } from './word-diff';

/** Join only the segments of a given type back into text, for assertions. */
function textOf(
	segments: ReturnType<typeof wordDiff>,
	type: 'equal' | 'insert' | 'delete',
): string {
	return segments
		.filter((s) => s.type === type)
		.map((s) => s.text)
		.join('');
}

test('identical input yields all-equal segments and round-trips', () => {
	const segments = wordDiff('the quick brown fox', 'the quick brown fox');
	expect(segments.every((s) => s.type === 'equal')).toBe(true);
	expect(segments.map((s) => s.text).join('')).toBe('the quick brown fox');
});

test('a one-word fix marks the old word deleted and the new word inserted', () => {
	const segments = wordDiff('the quik brown fox', 'the quick brown fox');
	expect(textOf(segments, 'delete')).toBe('quik');
	expect(textOf(segments, 'insert')).toBe('quick');
	// Unchanged words stay equal on both sides.
	expect(textOf(segments, 'equal')).toContain('the');
	expect(textOf(segments, 'equal')).toContain('brown fox');
});

test('reconstructs the candidate from equal + insert segments', () => {
	const original = 'lets ship it tomorow';
	const candidate = 'we should ship it tomorrow';
	const segments = wordDiff(original, candidate);
	const rebuilt = segments
		.filter((s) => s.type !== 'delete')
		.map((s) => s.text)
		.join('');
	expect(rebuilt).toBe(candidate);
});

test('reconstructs the original from equal + delete segments', () => {
	const original = 'lets ship it tomorow';
	const candidate = 'we should ship it tomorrow';
	const segments = wordDiff(original, candidate);
	const rebuilt = segments
		.filter((s) => s.type !== 'insert')
		.map((s) => s.text)
		.join('');
	expect(rebuilt).toBe(original);
});

test('empty original makes the whole candidate an insertion', () => {
	const segments = wordDiff('', 'brand new text');
	expect(textOf(segments, 'insert')).toBe('brand new text');
	expect(textOf(segments, 'delete')).toBe('');
});
