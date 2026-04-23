import { describe, expect, test } from 'bun:test';
import { resolveEntry } from './resolve-entry';

const fakeEntry = (name: string) =>
	({ name, handle: {} }) as Parameters<typeof resolveEntry>[0][number];

describe('resolveEntry', () => {
	test('auto-selects when only one entry exists', () => {
		const notes = fakeEntry('notes');
		expect(resolveEntry([notes], undefined)).toBe(notes);
	});

	test('auto-selects single entry even when -w is provided', () => {
		const notes = fakeEntry('notes');
		expect(resolveEntry([notes], 'notes')).toBe(notes);
	});

	test('selects by name with -w for multiple entries', () => {
		const tasks = fakeEntry('tasks');
		expect(resolveEntry([fakeEntry('notes'), tasks], 'tasks')).toBe(tasks);
	});

	test('throws when multiple entries and no -w', () => {
		const entries = [fakeEntry('notes'), fakeEntry('tasks')];
		expect(() => resolveEntry(entries, undefined)).toThrow(
			'Multiple workspaces found',
		);
	});

	test('throws when -w names a nonexistent entry', () => {
		const entries = [fakeEntry('notes'), fakeEntry('tasks')];
		expect(() => resolveEntry(entries, 'foo')).toThrow(
			"No workspace 'foo'",
		);
	});
});
