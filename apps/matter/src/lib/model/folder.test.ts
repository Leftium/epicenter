import { describe, expect, test } from 'bun:test';
import { readFolder } from './folder';

describe('readFolder', () => {
	test('splits readable rows from unreadable files and infers columns', () => {
		const result = readFolder([
			{ path: 'a.md', content: '---\ntitle: A\nrating: 5\n---\nbody' },
			{ path: 'b.md', content: '---\ntitle: B\n---\nbody' },
			{ path: 'broken.md', content: '---\ntitle: [unclosed\n---\nbody' },
			{ path: 'conflict.md', content: '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> z\n' },
			{ path: 'raw.md', content: '# no frontmatter' },
		]);

		expect(result.rows.map((r) => r.path)).toEqual(['a.md', 'b.md', 'raw.md']);
		expect(result.unreadable).toEqual([
			{ path: 'broken.md', reason: 'invalid-yaml' },
			{ path: 'conflict.md', reason: 'conflict-markers' },
		]);
		expect(result.columns).toEqual([
			{ key: 'title', kind: 'string', array: false, count: 2 },
			{ key: 'rating', kind: 'integer', array: false, count: 1 },
		]);
	});
});
