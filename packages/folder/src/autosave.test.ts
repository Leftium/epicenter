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
 * - Each write is guarded by the capture the previous one confirmed, and
 *   `saved` carries it
 * - Failure is terminal until the caller requests again; nothing retries
 * - Writer throws are `UnexpectedWriterError`; observer throws strand nothing
 * - A table session writes only valid rows, so what it saves reads back
 * - A change made elsewhere, or a deleted file, is `Conflict`, never
 *   overwritten or recreated
 * - A save reported `Unconfirmed` that did land is confirmed by one read
 */
import { describe, expect, test } from 'bun:test';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createAutosave, type SaveState } from './autosave.js';
import type { FolderStorage } from './boundary.js';
import { rawBrowserFolder } from './browser-storage.test-support.js';
import { type FileCapture, hashBytes } from './capture.js';
import { defineFolder, defineTable, field } from './contract.js';
import { FileError } from './errors.js';
import { createFiles } from './files.js';
import { createTable } from './table.js';

type Failure = { message: string };

/** The capture a controlled write of `text` reports. */
const at = (text: string): FileCapture => ({ path: 'f', sha256: text });
const saved = (text: string) => ({ status: 'saved', file: at(text) }) as const;

/** A writer whose completions the test resolves one at a time. */
function controlledWriter() {
	type Write = ReturnType<
		typeof Promise.withResolvers<Result<undefined, Failure>>
	> & { text: string; over: FileCapture };
	let incoming = Promise.withResolvers<Write>();
	const texts: string[] = [];
	const guards: string[] = [];
	let active = 0;
	let maxActive = 0;
	return {
		texts,
		guards,
		get maxActive() {
			return maxActive;
		},
		next: () => incoming.promise,
		async write(
			text: string,
			over: FileCapture,
		): Promise<Result<FileCapture, Failure>> {
			const completion = Promise.withResolvers<Result<undefined, Failure>>();
			texts.push(text);
			guards.push(over.sha256);
			active++;
			maxActive = Math.max(maxActive, active);
			const notification = incoming;
			incoming = Promise.withResolvers<Write>();
			notification.resolve({ text, over, ...completion });
			try {
				const result = await completion.promise;
				return result.error === null ? Ok(at(text)) : result;
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
		file: at('initial'),
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
		expect(await saves.settled()).toEqual(saved('initial'));
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
		expect(await settled).toEqual(saved('C'));
		expect(states).toEqual([{ status: 'saving' }, saved('C')]);
		expect(writer.texts).toEqual(['A', 'C']);
		expect(writer.maxActive).toBe(1);
	});

	test('each write is guarded by the capture the previous one confirmed', async () => {
		const { writer, saves } = setup();
		for (const text of ['A', 'B']) {
			const next = writer.next();
			saves.request({ text });
			(await next).resolve(Ok(undefined));
			await saves.settled();
		}
		const failing = writer.next();
		saves.request({ text: 'C' });
		(await failing).resolve(Err({ message: 'refused' }));
		await saves.settled();
		const after = writer.next();
		saves.request({ text: 'D' });
		(await after).resolve(Ok(undefined));
		await saves.settled();
		// A failed write confirms nothing, so D is guarded by B.
		expect(writer.guards).toEqual(['initial', 'A', 'B', 'B']);
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
		const refusal = {
			status: 'error',
			error: { message: 'cannot save C' },
		} as const;
		expect(states.at(-1)).toEqual(refusal);
		active.resolve(Ok(undefined));
		expect(await saves.settled()).toEqual(refusal);
		// B was pending before C failed, and C's failure dropped it.
		expect(writer.texts).toEqual(['A']);
		expect(states).toEqual([{ status: 'saving' }, refusal]);
	});

	test('a valid request after a preparation failure saves over what the older write confirmed', async () => {
		const { writer, saves } = setup();
		const first = writer.next();
		saves.request({ text: 'A' });
		const active = await first;
		saves.request({ text: 'X', refuse: true });
		active.resolve(Ok(undefined));
		expect(await saves.settled()).toMatchObject({ status: 'error' });
		const next = writer.next();
		saves.request({ text: 'D' });
		(await next).resolve(Ok(undefined));
		expect(await saves.settled()).toEqual(saved('D'));
		expect(writer.guards).toEqual(['initial', 'A']);
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
		expect(await saves.settled()).toEqual(saved('C'));
		expect(states).toEqual([{ status: 'saving' }, saved('C')]);
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
		expect(await saves.settled()).toEqual(saved('A'));
		expect(writer.texts).toEqual(['A', 'A']);
	});

	test('terminal observer work joins the batch', async () => {
		const writer = controlledWriter();
		let requested = false;
		const saves = createAutosave({
			file: at('initial'),
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
		expect(await settled).toEqual(saved('B'));
		expect(writer.texts).toEqual(['A', 'B']);
		expect(writer.maxActive).toBe(1);
	});

	for (const synchronous of [true, false])
		test(`a writer ${synchronous ? 'throw' : 'rejection'} is an UnexpectedWriterError`, async () => {
			const cause = new Error('broken');
			const saves = createAutosave({
				file: at('initial'),
				prepare: (text: string) => Ok(text),
				write: (): Promise<Result<FileCapture, Failure>> => {
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
			file: at('initial'),
			prepare: (text: string) => Ok(text),
			write: async (text: string) => Ok(at(text)),
			onState(state) {
				frozen.push(Object.isFrozen(state));
				throw new Error('Broken observer');
			},
		});
		saves.request('A');
		expect(await saves.settled()).toEqual(saved('A'));
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
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A folder whose next write can be reported `Unconfirmed`, landed or not,
 * the way a host that loses its reply does.
 */
async function folderSetup() {
	const base = (await rawBrowserFolder({ id: 'autosave' })).boundary;
	let unconfirm: 'landed' | 'lost' | undefined;
	const storage: FolderStorage = {
		...base,
		async apply(changes) {
			const mode = unconfirm;
			unconfirm = undefined;
			if (mode === undefined) return base.apply(changes);
			if (mode === 'landed') await base.apply(changes);
			return FileError.Unconfirmed({
				path: 'the file',
				operation: 'publishing',
				cause: 'the reply was lost',
			});
		},
	};
	const table = createTable<Todo>(
		{ storage },
		'todos',
		definition.tables.todos,
	);
	const files = createFiles({ storage });
	return {
		table,
		files,
		unconfirmNext(mode: 'landed' | 'lost') {
			unconfirm = mode;
		},
		async overwrite(path: string, text: string) {
			const bytes = encoder.encode(text);
			expectOk(
				await base.apply([
					{ kind: 'overwrite', path, bytes, sha256: await hashBytes(bytes) },
				]),
			);
		},
		async text(path: string) {
			const read = await base.read(path);
			return read.error === null ? decoder.decode(read.data.bytes) : undefined;
		},
	};
}

async function createdTodo(s: Awaited<ReturnType<typeof folderSetup>>) {
	return expectOk(
		await s.table.create(
			{ fields: { title: 'A', done: false }, body: '' },
			{ stem: 'a' },
		),
	);
}

describe('table.autosave', () => {
	test('saves the latest valid row, and saved carries its capture', async () => {
		const s = await folderSetup();
		const created = await createdTodo(s);
		const states: string[] = [];
		const saves = s.table.autosave(created, {
			onState: (state) => states.push(state.status),
		});
		const { row } = created;
		row.fields.title = 'B';
		saves.request(row);
		row.fields.title = 'later, unrequested';
		const settled = await saves.settled();
		expect(await s.text('todos/a.md')).toBe(
			'---\ntitle: B\ndone: false\n---\n',
		);
		expect(states).toEqual(['saving', 'saved']);
		if (settled.status !== 'saved') throw new Error('not saved');
		// The saved capture guards the next action on the same file.
		expectOk(await s.table.rename(settled.file, 'b'));
	});

	test('a draft that is not a valid row is the request’s error and is never written', async () => {
		const s = await folderSetup();
		const created = await createdTodo(s);
		const states: SaveState<unknown>[] = [];
		const saves = s.table.autosave(created, {
			onState: (state) => states.push(state),
		});
		const { row } = created;
		(row.fields as Record<string, unknown>).done = 'not yet';
		saves.request(row);
		expect(states).toMatchObject([
			{
				status: 'error',
				error: { name: 'InvalidValues', issues: [{ field: 'done' }] },
			},
		]);
		saves.request({
			fields: { title: 'x', done: Number.NaN as never },
			body: '',
		});
		expect(states.at(-1)).toMatchObject({
			status: 'error',
			error: { name: 'InvalidValues' },
		});
		expect(expectOk(await s.table.get('a'))).toEqual({
			path: created.path,
			sha256: created.sha256,
			row: { fields: { title: 'A', done: false }, body: '' },
		});
	});

	test('a change made elsewhere is Conflict, and the other change stays', async () => {
		const s = await folderSetup();
		const created = await createdTodo(s);
		const saves = s.table.autosave(created, { onState() {} });
		const pulled = '---\ntitle: Pulled\ndone: true\n---\n';
		await s.overwrite('todos/a.md', pulled);
		saves.request({ fields: { title: 'Mine', done: false }, body: '' });
		expect(await saves.settled()).toMatchObject({
			status: 'error',
			error: { name: 'Conflict' },
		});
		expect(await s.text('todos/a.md')).toBe(pulled);
	});

	test('a deleted row is Conflict and is never recreated', async () => {
		const s = await folderSetup();
		const created = await createdTodo(s);
		expectOk(await s.table.delete(created));
		const saves = s.table.autosave(created, { onState() {} });
		saves.request(created.row);
		expect(await saves.settled()).toMatchObject({
			status: 'error',
			error: { name: 'Conflict' },
		});
		expect(await s.text('todos/a.md')).toBeUndefined();
	});

	test('a capture of another table is every request’s InvalidPath', async () => {
		const s = await folderSetup();
		const saves = s.table.autosave(
			{ path: 'notes/a.md', sha256: '0'.repeat(64) },
			{ onState() {} },
		);
		saves.request({ fields: { title: 'x', done: false }, body: '' });
		expect(await saves.settled()).toMatchObject({
			status: 'error',
			error: { name: 'InvalidPath' },
		});
	});
});

describe('files.autosave', () => {
	test('each save is guarded by the bytes the previous one confirmed', async () => {
		const s = await folderSetup();
		const capture = expectOk(await s.files.create('notes.txt', 'one'));
		const saves = s.files.autosave(capture, { onState() {} });
		saves.request('two');
		expect(await saves.settled()).toMatchObject({ status: 'saved' });
		saves.request('three');
		expect(await saves.settled()).toMatchObject({ status: 'saved' });
		expect(await s.text('notes.txt')).toBe('three');

		await s.overwrite('notes.txt', 'changed elsewhere');
		saves.request('four');
		expect(await saves.settled()).toMatchObject({
			status: 'error',
			error: { name: 'Conflict' },
		});
		expect(await s.text('notes.txt')).toBe('changed elsewhere');
	});

	test('an Unconfirmed save that landed is confirmed by one read, and the session continues', async () => {
		const s = await folderSetup();
		const capture = expectOk(await s.files.create('notes.txt', 'one'));
		const saves = s.files.autosave(capture, { onState() {} });
		s.unconfirmNext('landed');
		saves.request('two');
		expect(await saves.settled()).toEqual({
			status: 'saved',
			file: {
				path: 'notes.txt',
				sha256: await hashBytes(encoder.encode('two')),
			},
		});
		saves.request('three');
		expect(await saves.settled()).toMatchObject({ status: 'saved' });
		expect(await s.text('notes.txt')).toBe('three');
	});

	test('an Unconfirmed save that did not land stays Unconfirmed', async () => {
		const s = await folderSetup();
		const capture = expectOk(await s.files.create('notes.txt', 'one'));
		const saves = s.files.autosave(capture, { onState() {} });
		s.unconfirmNext('lost');
		saves.request('two');
		expect(await saves.settled()).toMatchObject({
			status: 'error',
			error: { name: 'Unconfirmed' },
		});
		saves.request('two');
		expect(await saves.settled()).toMatchObject({ status: 'saved' });
	});

	test('an invalid capture is every request’s error, and nothing is written', async () => {
		const s = await folderSetup();
		const saves = s.files.autosave(
			{ path: 'notes.txt', sha256: 'nope' },
			{ onState() {} },
		);
		saves.request('text');
		expect(await saves.settled()).toMatchObject({
			status: 'error',
			error: { name: 'InvalidPath' },
		});
		expect(expectErr(await s.files.read('notes.txt')).name).toBe('NotFound');
	});
});
