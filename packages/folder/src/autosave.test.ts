/**
 * Autosave Tests
 *
 * Snapshot saves under controlled write completions, then the two folder
 * sessions built on them: `table.autosave` for a row and `files.autosave`
 * for raw content.
 *
 * Key behaviors:
 * - Construction and waiting submit nothing and report nothing
 * - One write runs at a time; only the latest pending request is written
 * - A request is prepared before it returns, so later edits change nothing
 * - A preparation failure is the latest request's error at once: it drops
 *   pending work, and an older write that finishes cannot report `saved`
 * - Failure is terminal until the caller requests again; nothing retries
 * - Writer throws are `UnexpectedWriterError`; observer throws strand nothing
 * - A table session formats each row, saves drafts that fail the schema, and
 *   never recreates a deleted row
 * - A file session guards each save by the previous confirmed bytes, so a
 *   change made elsewhere is `Conflict`
 */
import { describe, expect, test } from 'bun:test';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { createAutosave, type SaveState } from './autosave.js';
import { rawBrowserFolder } from './browser-storage.test-support.js';
import { hashBytes } from './capture.js';
import { defineFolder, defineTable, field } from './contract.js';
import { createFiles } from './files.js';
import type { Row } from './row-text.js';
import { createTable } from './table.js';

type Failure = { message: string };

/** A writer whose completions the test resolves one at a time. */
function controlledWriter() {
	type Write = ReturnType<
		typeof Promise.withResolvers<Result<undefined, Failure>>
	> & { text: string };
	let incoming = Promise.withResolvers<Write>();
	const texts: string[] = [];
	let active = 0;
	let maxActive = 0;
	return {
		texts,
		get maxActive() {
			return maxActive;
		},
		next: () => incoming.promise,
		async write(text: string) {
			const completion = Promise.withResolvers<Result<undefined, Failure>>();
			texts.push(text);
			active++;
			maxActive = Math.max(maxActive, active);
			const notification = incoming;
			incoming = Promise.withResolvers<Write>();
			notification.resolve({ text, ...completion });
			try {
				return await completion.promise;
			} finally {
				active--;
			}
		},
	};
}

/** Text snapshots of `{ text }` values; `refuse` makes preparation fail. */
function setup() {
	const writer = controlledWriter();
	const states: SaveState<unknown>[] = [];
	const saves = createAutosave({
		prepare: (value: { text: string; refuse?: boolean }) =>
			value.refuse
				? Err({ message: `cannot save ${value.text}` })
				: Ok(value.text),
		write: writer.write,
		onState: (state) => states.push(state),
	});
	return { writer, states, saves };
}

describe('snapshot saves', () => {
	test('construction and waiting submit nothing', async () => {
		const { writer, states, saves } = setup();
		expect(await saves.settled()).toEqual({ status: 'saved' });
		expect(writer.texts).toEqual([]);
		expect(states).toEqual([]);
	});

	test('writes A then C, skips B, and shares one batch wait', async () => {
		const { writer, states, saves } = setup();
		const first = writer.next();
		saves.request({ text: 'A' });
		saves.request({ text: 'B' });
		saves.request({ text: 'C' });
		const settled = saves.settled();
		expect(saves.settled()).toBe(settled);
		const active = await first;
		const second = writer.next();
		active.resolve(Ok(undefined));
		const last = await second;
		expect(last.text).toBe('C');
		last.resolve(Ok(undefined));
		expect(await settled).toEqual({ status: 'saved' });
		expect(states).toEqual([{ status: 'saving' }, { status: 'saved' }]);
		expect(writer.texts).toEqual(['A', 'C']);
		expect(writer.maxActive).toBe(1);
	});

	test('a request is prepared before it returns', async () => {
		const { writer, saves } = setup();
		const value = { text: 'before' };
		const first = writer.next();
		saves.request(value);
		value.text = 'after';
		(await first).resolve(Ok(undefined));
		await saves.settled();
		expect(writer.texts).toEqual(['before']);
	});

	test('a preparation failure during an older write stays the error after that write succeeds', async () => {
		const { writer, states, saves } = setup();
		const first = writer.next();
		saves.request({ text: 'A' });
		const active = await first;
		saves.request({ text: 'B' });
		saves.request({ text: 'C', refuse: true });
		expect(states.at(-1)).toEqual({
			status: 'error',
			error: { message: 'cannot save C' },
		});
		active.resolve(Ok(undefined));
		expect(await saves.settled()).toEqual({
			status: 'error',
			error: { message: 'cannot save C' },
		});
		// B was pending before C failed, and C's failure dropped it.
		expect(writer.texts).toEqual(['A']);
		expect(states).toEqual([
			{ status: 'saving' },
			{ status: 'error', error: { message: 'cannot save C' } },
		]);
	});

	test('a valid request after a preparation failure saves and recovers', async () => {
		const { writer, saves } = setup();
		saves.request({ text: 'X', refuse: true });
		expect(await saves.settled()).toMatchObject({ status: 'error' });
		const first = writer.next();
		saves.request({ text: 'D' });
		(await first).resolve(Ok(undefined));
		expect(await saves.settled()).toEqual({ status: 'saved' });
		expect(writer.texts).toEqual(['D']);
	});

	test('an admitted newer snapshot proceeds after an older failure', async () => {
		const { writer, states, saves } = setup();
		const first = writer.next();
		saves.request({ text: 'A' });
		const active = await first;
		saves.request({ text: 'C' });
		const second = writer.next();
		active.resolve(Err({ message: 'A failed' }));
		(await second).resolve(Ok(undefined));
		expect(await saves.settled()).toEqual({ status: 'saved' });
		expect(states).toEqual([{ status: 'saving' }, { status: 'saved' }]);
		expect(writer.texts).toEqual(['A', 'C']);
	});

	test('failure stays terminal until the caller requests again, identical text included', async () => {
		const { writer, saves } = setup();
		const first = writer.next();
		saves.request({ text: 'A' });
		(await first).resolve(Err({ message: 'Unavailable' }));
		expect(await saves.settled()).toEqual({
			status: 'error',
			error: { message: 'Unavailable' },
		});
		const retry = writer.next();
		saves.request({ text: 'A' });
		(await retry).resolve(Ok(undefined));
		expect(await saves.settled()).toEqual({ status: 'saved' });
		expect(writer.texts).toEqual(['A', 'A']);
	});

	test('terminal observer work joins the batch', async () => {
		const writer = controlledWriter();
		let requested = false;
		const saves = createAutosave({
			prepare: (text: string) => Ok(text),
			write: writer.write,
			onState(state) {
				if (state.status === 'saved' && !requested) {
					requested = true;
					saves.request('B');
				}
			},
		});
		const first = writer.next();
		saves.request('A');
		const settled = saves.settled();
		const active = await first;
		const second = writer.next();
		active.resolve(Ok(undefined));
		(await second).resolve(Ok(undefined));
		expect(await settled).toEqual({ status: 'saved' });
		expect(writer.texts).toEqual(['A', 'B']);
		expect(writer.maxActive).toBe(1);
	});

	for (const synchronous of [true, false])
		test(`a writer ${synchronous ? 'throw' : 'rejection'} is an UnexpectedWriterError`, async () => {
			const cause = new Error('broken');
			const saves = createAutosave({
				prepare: (text: string) => Ok(text),
				write: () => {
					if (synchronous) throw cause;
					return Promise.reject(cause);
				},
				onState() {},
			});
			saves.request('A');
			expect(await saves.settled()).toMatchObject({
				status: 'error',
				error: { name: 'UnexpectedWriterError', cause },
			});
		});

	test('observer exceptions cannot strand a batch, and states are frozen', async () => {
		const frozen: boolean[] = [];
		const saves = createAutosave({
			prepare: (text: string) => Ok(text),
			write: async () => Ok(undefined),
			onState(state) {
				frozen.push(Object.isFrozen(state));
				throw new Error('Broken observer');
			},
		});
		saves.request('A');
		expect(await saves.settled()).toEqual({ status: 'saved' });
		expect(frozen).toEqual([true, true]);
	});
});

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
type Todo = { title: string; done: boolean };
const decoder = new TextDecoder();

async function folderSetup() {
	const storage = (await rawBrowserFolder({ id: 'autosave' })).boundary;
	const table = createTable<Todo>(
		{ storage },
		'todos',
		definition.tables.todos,
	);
	const files = createFiles({ storage });
	const text = async (path: string) => {
		const read = await storage.read(path);
		return read.error === null ? decoder.decode(read.data.bytes) : undefined;
	};
	return { storage, table, files, text };
}

describe('table.autosave', () => {
	test('saves the latest complete row, a draft that fails the schema included', async () => {
		const { table, text } = await folderSetup();
		const created = expectOk(
			await table.create(
				{ fields: { title: 'A', done: false }, body: '' },
				{ stem: 'a' },
			),
		);
		const states: string[] = [];
		const saves = table.autosave('a', {
			onState: (state) => states.push(state.status),
		});
		const row: Row<Todo> = created.row;
		row.fields.title = '';
		(row.fields as Record<string, unknown>).done = 'not yet';
		saves.request(row);
		row.fields.title = 'later, unrequested';
		expect(await saves.settled()).toEqual({ status: 'saved' });
		expect(await text('todos/a.md')).toBe(
			'---\n"title": ""\n"done": "not yet"\n---\n',
		);
		expect(states).toEqual(['saving', 'saved']);
	});

	test('a row that cannot be written is the request’s error at once', async () => {
		const { table } = await folderSetup();
		const states: SaveState<unknown>[] = [];
		const saves = table.autosave('a', { onState: (s) => states.push(s) });
		saves.request({
			fields: { title: 'x', done: Number.NaN as never },
			body: '',
		});
		expect(states).toMatchObject([
			{ status: 'error', error: { name: 'InvalidValues' } },
		]);
	});

	test('a deleted row is NotFound and is never recreated', async () => {
		const { table, text } = await folderSetup();
		const created = expectOk(
			await table.create(
				{ fields: { title: 'A', done: false }, body: '' },
				{ stem: 'a' },
			),
		);
		expectOk(await table.delete(created));
		const saves = table.autosave('a', { onState() {} });
		saves.request(created.row);
		expect(await saves.settled()).toMatchObject({
			status: 'error',
			error: { name: 'NotFound' },
		});
		expect(await text('todos/a.md')).toBeUndefined();
	});
});

describe('files.autosave', () => {
	test('each save is guarded by the bytes the previous one confirmed', async () => {
		const { files, storage, text } = await folderSetup();
		const capture = expectOk(await files.create('notes.txt', 'one'));
		const saves = files.autosave(capture, { onState() {} });
		saves.request('two');
		expect(await saves.settled()).toEqual({ status: 'saved' });
		saves.request('three');
		expect(await saves.settled()).toEqual({ status: 'saved' });
		expect(await text('notes.txt')).toBe('three');

		const elsewhere = new TextEncoder().encode('changed elsewhere');
		expectOk(
			await storage.apply([
				{
					kind: 'overwrite',
					path: 'notes.txt',
					bytes: elsewhere,
					sha256: await hashBytes(elsewhere),
				},
			]),
		);
		saves.request('four');
		expect(await saves.settled()).toMatchObject({
			status: 'error',
			error: { name: 'Conflict' },
		});
		expect(await text('notes.txt')).toBe('changed elsewhere');
	});

	test('an invalid capture is every request’s error, and nothing is written', async () => {
		const { files } = await folderSetup();
		const saves = files.autosave(
			{ path: 'notes.txt', sha256: 'nope' },
			{ onState() {} },
		);
		saves.request('text');
		expect(await saves.settled()).toMatchObject({
			status: 'error',
			error: { name: 'InvalidPath' },
		});
	});
});
