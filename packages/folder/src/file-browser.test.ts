import { expect, test } from 'bun:test';
import { Err, Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { submittedText } from './capture.js';
import { FileError } from './errors.js';
import { readTextFile } from './file-browser.js';

test('the caller owns the editable-byte limit, including its exact boundary', async () => {
	const bytes = new TextEncoder().encode('abc');
	const files = {
		read: async (path: string) => Ok({ path, bytes, sha256: 'captured' }),
	};
	expect(expectOk(await readTextFile(files, 'note.txt', 2))).toEqual({
		kind: 'tooLarge',
		size: 3,
	});
	expect(expectOk(await readTextFile(files, 'note.txt', 3))).toEqual({
		kind: 'text',
		file: { path: 'note.txt', text: 'abc', sha256: 'captured' },
	});
});

test('a failed read preserves its refusal instead of classifying an absent file', async () => {
	const { error } = FileError.NotFound({ path: 'missing.txt' });
	const files = { read: async () => Err(error) };
	expect(await readTextFile(files, 'missing.txt', 10)).toEqual(Err(error));
});

test('submitted bytes preserve BOM and CRLF and replace an unpaired surrogate', () => {
	const { bytes, text } = submittedText('\ufeffnote\ud800\r\n');
	expect(text).toBe('\ufeffnote\ufffd\r\n');
	expect(bytes).toEqual(new TextEncoder().encode(text));
});
