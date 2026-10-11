/** Inert declarations validate identity and retain their schema without acquiring resources. */
import { expect, test } from 'bun:test';
import { defineStore } from './index.js';

const definition = defineStore({
	id: 'so.epicenter.notes',
	tables: {},
	kv: {},
});
test('the declaration exposes one identity and the schema without implementation options', () => {
	const input = { ...definition, title: 'Notes', runtime: 'discarded option' };
	// @ts-expect-error Inert declarations accept no implementation options.
	const titledDefinition = defineStore(input);
	expect(titledDefinition.id).toBe(definition.id);
	expect(titledDefinition.title).toBe('Notes');
	// Each definition is its own prepared snapshot of the same declaration.
	expect(titledDefinition.tables).toEqual(definition.tables);
	expect(titledDefinition.kv).toEqual(definition.kv);
	expect(titledDefinition.tables).not.toBe(definition.tables);
	expect(Object.keys(titledDefinition).sort()).toEqual([
		'id',
		'kv',
		'tables',
		'title',
	]);
	expect(Object.isFrozen(titledDefinition)).toBe(true);
});

test('a store definition ID this platform cannot file refuses at construction', () => {
	expect(() => defineStore({ ...definition, id: 'not a store id' })).toThrow(
		'is not valid',
	);
});
