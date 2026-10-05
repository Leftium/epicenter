/**
 * Todos file editing policy tests.
 *
 * Todos opens text up to 1 MiB in its editor and larger files as details.
 * Shared tree ordering and text classification are covered beside their
 * implementation in `packages/folder/src/file-browser.test.ts`.
 */
import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { EDITABLE_TEXT_LIMIT, readTextFile } from './files.js';

test('Todos edits text through 1 MiB and opens larger files as details', async () => {
	expect(EDITABLE_TEXT_LIMIT).toBe(1024 * 1024);
	let bytes = new Uint8Array(EDITABLE_TEXT_LIMIT).fill(0x61);
	const files = {
		read: async (path: string) => Ok({ path, bytes, sha256: 'captured' }),
	};
	expect(expectOk(await readTextFile(files, 'large.txt')).kind).toBe('text');
	bytes = new Uint8Array(EDITABLE_TEXT_LIMIT + 1).fill(0x61);
	expect(expectOk(await readTextFile(files, 'large.txt'))).toEqual({
		kind: 'tooLarge',
		size: EDITABLE_TEXT_LIMIT + 1,
	});
});
