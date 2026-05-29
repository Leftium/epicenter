import { describe, expect, test } from 'bun:test';

import {
	markdownPath,
	resolveProjectPath,
	sqlitePath,
	yjsPath,
} from './workspace-paths.js';

describe('document/workspace-paths', () => {
	test('yjsPath places the update log under .epicenter/yjs/', () => {
		const dir = '/Users/me/vault';
		expect(yjsPath(dir, 'epicenter.fuji')).toBe(
			'/Users/me/vault/.epicenter/yjs/epicenter.fuji.db',
		);
	});

	test('sqlitePath places the database under .epicenter/sqlite/', () => {
		const dir = '/Users/me/vault';
		expect(sqlitePath(dir, 'epicenter.fuji')).toBe(
			'/Users/me/vault/.epicenter/sqlite/epicenter.fuji.db',
		);
	});

	test('markdownPath is a directory, not a file', () => {
		const dir = '/Users/me/vault';
		expect(markdownPath(dir, 'epicenter.fuji')).toBe(
			'/Users/me/vault/.epicenter/md/epicenter.fuji',
		);
	});

	describe('resolveProjectPath', () => {
		const dir = '/Users/me/vault';

		test('returns undefined when no override is given, so callers fall back', () => {
			expect(resolveProjectPath(dir, undefined)).toBeUndefined();
		});

		test('resolves a relative override against the project root', () => {
			expect(resolveProjectPath(dir, 'notes')).toBe('/Users/me/vault/notes');
		});

		test('passes an absolute override through unchanged', () => {
			expect(resolveProjectPath(dir, '/tmp/notes')).toBe('/tmp/notes');
		});
	});
});
