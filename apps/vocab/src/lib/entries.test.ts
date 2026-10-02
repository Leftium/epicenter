/**
 * Saved entry tests.
 * The real entries state runs over the real Personal store and persistence
 * queue, on a SQLite record that can refuse commits. "Saved" is read back from
 * a reopened record, never assumed from the table write.
 *
 * Key behaviors:
 * - A captured phrase is reported added only once storage holds it
 * - A phrase storage refused can be saved again without a second row
 * - Text is trimmed and otherwise exact; notes and stages start as the
 *   learner's blank slate
 */
import { expect, test } from 'bun:test';
import { createMemoryRecord, openMemory } from '@epicenter/app/memory';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { vocabDefinition } from './data.js';

// Bun runs the rune module uncompiled. The state reads the store on every
// call, so a derived value evaluated once is enough for these tests. Other
// test files install their own rune stubs in this process, so this one is
// installed again before each state is made, and carries `by` for them.
function stubDerived() {
	Reflect.set(
		globalThis,
		'$derived',
		Object.assign(<T>(value: T) => value, {
			by: <T extends object>(read: () => T) =>
				new Proxy({} as T, { get: (_target, key) => Reflect.get(read(), key) }),
		}),
	);
}
stubDerived();
const { createEntriesState } = await import('./entries.svelte.js');

async function setup() {
	stubDerived();
	const inner = createMemoryRecord();
	const gate = { failing: false };
	const data = await openMemory(vocabDefinition, {
		close: inner.close,
		sqlite: {
			run: inner.sqlite.run.bind(inner.sqlite),
			all: inner.sqlite.all.bind(inner.sqlite),
			transaction<TResult>(run: () => TResult): TResult {
				if (gate.failing) throw new Error('storage refused the commit');
				return inner.sqlite.transaction(run);
			},
		} as typeof inner.sqlite,
	});
	return {
		data,
		gate,
		entries: createEntriesState({ data }),
		/** What a restart would find. */
		async stored() {
			await using reopened = await openMemory(vocabDefinition, inner);
			return reopened.tables.entries.rows.map((row) => row.text).sort();
		},
		async [Symbol.asyncDispose]() {
			await data[Symbol.asyncDispose]();
			inner.close();
		},
	};
}

test('a phrase is reported added once storage holds it, with a blank note and the New stage', async () => {
	await using context = await setup();
	const { data, entries } = context;

	const saving = entries.savePhrase('  顺便  ');
	// Accepted into the live document at once; not yet called saved.
	expect(entries.has('顺便')).toBe(true);
	expect(expectOk(await saving)).toBe('added');
	expect(await context.stored()).toEqual(['顺便']);
	expect(data.tables.entries.rows).toMatchObject([
		{ text: '顺便', note: '', stage: 'new' },
	]);

	// The same exact text again writes nothing.
	expect(expectOk(await entries.savePhrase('顺便'))).toBe('present');
	expect(data.tables.entries.rows).toHaveLength(1);
});

test('a phrase storage refused is saved again without a second row, and a newer phrase is kept', async () => {
	await using context = await setup();
	const { data, gate, entries } = context;

	gate.failing = true;
	expect(expectErr(await entries.savePhrase('顺便')).name).toBe('NotSaved');
	expect(entries.has('顺便')).toBe(true);
	expect(entries.isStored).toBe(false);
	expect(await context.stored()).toEqual([]);

	// A newer phrase while the first is still unsaved, then the first again.
	expect(expectErr(await entries.savePhrase('by the way')).name).toBe(
		'NotSaved',
	);
	expect(expectErr(await entries.savePhrase('顺便')).name).toBe('NotSaved');
	expect(data.tables.entries.rows).toHaveLength(2);

	gate.failing = false;
	expect(expectOk(await entries.savePhrase('顺便'))).toBe('added');
	expect(entries.isStored).toBe(true);
	expect(data.tables.entries.rows).toHaveLength(2);
	expect(await context.stored()).toEqual(['by the way', '顺便']);
	// Storage took the newer phrase in the same flush; nothing is left to add.
	expect(expectOk(await entries.savePhrase('by the way'))).toBe('present');
	expect(data.tables.entries.rows).toHaveLength(2);
});

test('phrase text is trimmed and otherwise exact', async () => {
	await using context = await setup();
	const { data, entries } = context;

	expect(expectErr(await entries.savePhrase('   ')).name).toBe('Empty');
	expectOk(await entries.savePhrase('é 和 é。'));
	// A different spelling of the same letters is a different phrase.
	expect(expectOk(await entries.savePhrase('é 和 é。'))).toBe('added');
	expect(expectOk(await entries.savePhrase('银行，顺便买'))).toBe('added');
	expect(data.tables.entries.rows.map((row) => row.text).sort()).toEqual(
		['é 和 é。', 'é 和 é。', '银行，顺便买'].sort(),
	);
	expect(await context.stored()).toHaveLength(3);
});

test('saving a phrase again, stored or refused, leaves the learner’s note and stage alone', async () => {
	await using context = await setup();
	const { data, gate, entries } = context;

	expectOk(await entries.savePhrase('顺便'));
	const [entry] = data.tables.entries.rows;
	if (!entry) throw new Error('the phrase was not added');
	entries.setNote(entry.id, 'while I am at it');
	entries.setStage(entry.id, 'understood');
	await data.persistence.flush();

	expect(expectOk(await entries.savePhrase('顺便'))).toBe('present');
	// The retry path too: storage falls behind, and the same phrase is saved again.
	gate.failing = true;
	entries.setNote(entry.id, 'while I am at it, on the way');
	expectErr(await entries.savePhrase('顺便'));
	gate.failing = false;
	expect(expectOk(await entries.savePhrase('顺便'))).toBe('added');

	expect(data.tables.entries.rows).toMatchObject([
		{
			id: entry.id,
			text: '顺便',
			note: 'while I am at it, on the way',
			stage: 'understood',
		},
	]);
	expect(data.tables.entries.rows).toHaveLength(1);
});

test('a closed store answers with an error instead of rejecting, for a new phrase and a present one', async () => {
	const context = await setup();
	const { data, entries } = context;
	expectOk(await entries.savePhrase('顺便'));
	await context[Symbol.asyncDispose]();
	// The real closed store throws from its reads and its write.
	expect(() => data.tables.entries.rows).toThrow();
	expect(() =>
		data.tables.entries.create({
			text: 'x',
			note: '',
			stage: 'new',
			createdAt: '2026-10-03T00:00:00.000Z' as never,
		}),
	).toThrow();

	const fresh = expectErr(await entries.savePhrase('难怪'));
	expect(fresh.name).toBe('StorageThrew');
	expect(fresh).toHaveProperty('cause');
	expect(expectErr(await entries.savePhrase('顺便')).name).toBe('StorageThrew');
});
