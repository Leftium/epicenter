/**
 * Which folder changes reach the page. A write by any program is announced;
 * Git's own bookkeeping is not, except a branch movement.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isObservedChange, watchFolder } from './watch.js';

test('source files and branch movement are observed; Git bookkeeping is not', () => {
	expect(isObservedChange('recordings/a.md')).toBe(true);
	expect(isObservedChange('kv.json')).toBe(true);
	expect(isObservedChange('.git/refs/heads/main')).toBe(true);
	expect(isObservedChange('.git/HEAD')).toBe(true);
	expect(isObservedChange('.git/refs/heads/main.lock')).toBe(false);
	expect(isObservedChange('.git/index')).toBe(false);
	expect(isObservedChange('.git/objects/ab/cdef')).toBe(false);
	expect(isObservedChange('.git/epicenter/scratch/x')).toBe(false);
});

test('a write by another program is announced once per burst', async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-watch-')),
	);
	let announced = 0;
	const errors: unknown[] = [];
	const stop = watchFolder(
		root,
		() => {
			announced += 1;
		},
		(cause) => errors.push(cause),
	);
	try {
		await new Promise((resolve) => setTimeout(resolve, 200));
		await writeFile(join(root, 'a.md'), 'one');
		await writeFile(join(root, 'b.md'), 'two');
		await new Promise((resolve) => setTimeout(resolve, 2500));
		expect(errors).toEqual([]);
		expect(announced).toBe(1);
	} finally {
		stop();
		await rm(root, { recursive: true, force: true });
	}
});
