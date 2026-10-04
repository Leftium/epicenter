/**
 * Vocab folder declaration tests.
 * Pins the folder's ID and table names, which name its OPFS directory and
 * the table directories its files are saved under, and that the folder really
 * opens under that one ID every time.
 */
import { expect, test } from 'bun:test';
import { APPS } from '@epicenter/constants/apps';
import { vocabFolder } from './data.js';
import { VOCAB_FOLDER_ID } from './folder.js';
import { createBrowser } from './folder.test-support.js';

test('one folder under the app ID holds words, chats, and messages', () => {
	expect(VOCAB_FOLDER_ID).toBe(APPS.VOCAB.id);
	expect(Object.keys(vocabFolder.tables)).toEqual([
		'entries',
		'chats',
		'messages',
	]);
	expect(Object.keys(vocabFolder.kv)).toEqual([]);
});

test('the folder is this browser’s storage under the same name each time it opens', async () => {
	await using browser = createBrowser();
	const first = await browser.open();
	const location = first.location;
	expect(location).toEqual({
		kind: 'opfs',
		directory: 'Epicenter/local/so.epicenter.vocab',
	});
	await first.close();
	expect((await browser.open()).location).toEqual(location);
});
