/**
 * Vocab data declaration tests.
 * Pins the durable table names and shared domain identity of account vocabulary
 * and device chat definitions so changes cannot silently address different data.
 */
import { expect, test } from 'bun:test';
import { chatHistoryDefinition, vocabDefinition } from './data.js';

test('chat is device-owned while saved entries are account-owned', () => {
	expect(chatHistoryDefinition.id).toBe(vocabDefinition.id);
	expect(Object.keys(chatHistoryDefinition.tables)).toEqual([
		'messages',
		'chats',
	]);
	expect(Object.keys(chatHistoryDefinition.kv)).toEqual(['showPinyin']);
	expect(Object.keys(vocabDefinition.tables)).toEqual(['entries']);
	expect(Object.keys(vocabDefinition.kv)).toEqual([]);
});
