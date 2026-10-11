/** Platform normalization: empty reads, thrown platform failures, and write passthrough. */

import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type ClipboardSource, createClipboard } from './clipboard.js';

function source(overrides: Partial<ClipboardSource> = {}) {
	const written: string[] = [];
	const clipboard = createClipboard({
		readText: async () => written.at(-1) ?? '',
		async writeText(text) {
			written.push(text);
		},
		...overrides,
	});
	return { clipboard, written };
}

describe('readText', () => {
	test('returns the platform text', async () => {
		const { clipboard } = source({ readText: async () => 'hello' });
		expect(expectOk(await clipboard.readText())).toBe('hello');
	});

	test.each([
		['', 'empty'],
		[null, 'null'],
		[undefined, 'undefined'],
	])('normalizes a %p (%s) platform read to null', async (value) => {
		const { clipboard } = source({ readText: async () => value });
		expect(expectOk(await clipboard.readText())).toBeNull();
	});

	test('converts a platform failure to ClipboardRead', async () => {
		const cause = new DOMException(
			'Document is not focused.',
			'NotAllowedError',
		);
		const { clipboard } = source({
			readText: async () => {
				throw cause;
			},
		});
		const error = expectErr(await clipboard.readText());
		expect(error).toMatchObject({
			name: 'ClipboardRead',
			message: 'Failed to read from clipboard: Document is not focused.',
			cause,
		});
	});
});

describe('writeText', () => {
	test('writes through and reads back', async () => {
		const { clipboard, written } = source();
		expectOk(await clipboard.writeText('copied'));
		expect(written).toEqual(['copied']);
		expect(expectOk(await clipboard.readText())).toBe('copied');
	});

	test('converts a platform failure to ClipboardWrite', async () => {
		const cause = new Error('denied');
		const { clipboard } = source({
			writeText: async () => {
				throw cause;
			},
		});
		expect(expectErr(await clipboard.writeText('x'))).toMatchObject({
			name: 'ClipboardWrite',
			message: 'Failed to write to clipboard: denied',
			cause,
		});
	});
});
