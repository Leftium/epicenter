/**
 * Row Editor Tests
 *
 * Most tests acquire `table.edit` over storage whose reads and write replies
 * can be held one at a time, so each race happens at an exact moment. The
 * last test acquires the same editor from a real `@epicenter/folder/bun`
 * folder.
 *
 * Key behaviors:
 * - acquisition reads once; the editor never reads, watches, or adopts on its own
 * - readable invalid text opens for repair; storage errors never hide input
 * - setters install the complete accepted snapshot before they return
 * - one running write and the latest input after it; receipts never roll input back
 * - a settled write, failed or not, starts the waiting input before subscribers hear it
 * - a failure with nothing waiting ends `failed`; the next input saves again
 * - `waitForSaves` waits through consecutive writes, a subscriber's included, and never retries
 * - `reload` waits as `waitForSaves` does, then adopts the file unless input changed
 * - every write replaces the existing row and never recreates it
 * - nothing orders the editor's writes against other saves: the last to land stays
 *
 * See also:
 * - `canonical.test.ts` for the codec the editor formats and parses with
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { FileChange, FolderStorage } from './boundary.js';
import { openFolder } from './bun.js';
import { hashBytes } from './capture.js';
import {
	type CreateRowOf,
	defineFolder,
	defineTable,
	field,
	inspectRow,
} from './contract.js';
import type { RowEditor, RowEditorState } from './editor.js';
import { FileError } from './errors.js';
import { GIT_ENV, scratch } from './git-http.test-support.js';
import { createTable } from './table.js';

const originalEnv = { ...process.env };
beforeAll(() => {
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: {
				title: field.string({ minLength: 1 }),
				done: field.boolean(),
				priority: field.select(['low', 'normal', 'high']),
			},
		}),
	},
});
type Todo = CreateRowOf<typeof definition.tables.todos>;
type Editor = RowEditor<Todo>;
type State = RowEditorState<Todo>;

const PATH = 'todos/plan.md';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** A valid row in canonical form, with optional extra fields after the declared ones. */
function row(title: string, body = 'Body.\n', extra = '') {
	return `---\n"title": "${title}"\n"done": false\n"priority": "normal"\n${extra}---\n${body}`;
}

/** A valid row another tool wrote: a comment, undeclared keys, YAML spelling. */
const STYLED = [
	'---',
	'# written by hand',
	'owner: sam',
	'title: Plan',
	'meta: {b: 1, a: [true, null]}',
	'priority: normal',
	'done: false',
	'---',
	'Body A.',
	'',
].join('\n');

const READ_FAILURE = FileError.Io({
	path: PATH,
	operation: 'read',
	cause: 'EIO',
}).error;

async function flush() {
	for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
}

async function until(condition: () => boolean) {
	for (let i = 0; i < 200 && !condition(); i += 1)
		await new Promise((r) => setTimeout(r, 5));
	expect(condition()).toBe(true);
}

/** Whether `promise` has settled once queued work has run. */
async function hasSettled(promise: Promise<unknown>) {
	let done = false;
	void promise.then(() => {
		done = true;
	});
	await flush();
	return done;
}

/** The title of a valid row, or the row's status. */
function shown(editor: Editor): unknown {
	const { row } = editor.get();
	return row.status === 'valid' ? row.fields.title : row.status;
}

/** Record every snapshot an invalidation exposes. */
function record(editor: Editor) {
	const seen: State[] = [];
	const stop = editor.subscribe(() => seen.push(editor.get()));
	return { seen, stop, saves: () => seen.map((state) => state.save.status) };
}

type Outcome = 'ok' | 'unconfirmed' | 'io' | 'throw';

/**
 * The todos table over one row file. Reads see the file as it was when they
 * started and can be held or made to fail. A write can be held before it
 * lands; it lands, then waits for its reply when replies are held. A replace
 * of a missing file is `NotFound` and writes nothing.
 */
function createFakeTable(initial: string | Uint8Array | undefined) {
	let content = initial;
	let reads = 0;
	let holdingReads = false;
	let readFault: FileError | undefined;
	const heldReads: PromiseWithResolvers<void>[] = [];
	let holdingReplies = false;
	const heldReplies: PromiseWithResolvers<void>[] = [];
	let landing: PromiseWithResolvers<void> | undefined;
	const outcomes: Outcome[] = [];
	/** Text that landed. */
	const writes: string[] = [];
	const applied: FileChange[] = [];
	/** Text of every write the editor sent, landed or not. */
	const attempts: string[] = [];
	const unused = () => {
		throw new Error('A row editor does not call this storage method');
	};
	const storage: FolderStorage = {
		async read(path) {
			reads += 1;
			const seen = content;
			const fault = readFault;
			if (holdingReads) {
				const gate = Promise.withResolvers<void>();
				heldReads.push(gate);
				await gate.promise;
			}
			if (fault !== undefined) return { data: null, error: fault };
			if (seen === undefined) return FileError.NotFound({ path });
			const bytes = typeof seen === 'string' ? encoder.encode(seen) : seen;
			return Ok({ bytes, sha256: await hashBytes(bytes) });
		},
		async apply(changes) {
			const outcome = outcomes.shift() ?? 'ok';
			const [change] = changes;
			if (
				changes.length !== 1 ||
				change?.kind !== 'replace' ||
				change.expectedSha256 !== undefined
			)
				throw new Error('An editor applies one unguarded replace');
			applied.push(change);
			attempts.push(decoder.decode(change.bytes));
			const held = landing;
			landing = undefined;
			if (held !== undefined) await held.promise;
			const missing = content === undefined;
			if (!missing && outcome !== 'io') {
				content = decoder.decode(change.bytes);
				writes.push(content);
			}
			if (holdingReplies) {
				const gate = Promise.withResolvers<void>();
				heldReplies.push(gate);
				await gate.promise;
			}
			if (missing) return FileError.NotFound({ path: PATH });
			if (outcome === 'io')
				return FileError.Io({
					path: PATH,
					operation: 'replace',
					cause: 'disk full',
				});
			if (outcome === 'throw') throw new Error('a broken port');
			if (outcome === 'unconfirmed')
				return FileError.Unconfirmed({
					path: PATH,
					operation: 'replace',
					cause: 'the reply was lost',
				});
			return Ok(undefined);
		},
		list: unused,
		children: unused,
		readMany: unused,
		open: unused,
		mkdir: unused,
		rmdir: unused,
	};
	const table = createTable<Todo>(
		{ storage },
		'todos',
		definition.tables.todos.fields,
	);
	return {
		table,
		writes,
		applied,
		attempts,
		disk: () => content,
		reads: () => reads,
		/** Another writer changes the file; `undefined` deletes it. */
		writeElsewhere(next: string | Uint8Array | undefined) {
			content = next;
		},
		/** Reads started from now return `error`; `undefined` stops it. */
		failReads(error: FileError | undefined) {
			readFault = error;
		},
		holdReads() {
			holdingReads = true;
		},
		heldReads: () => heldReads.length,
		/** Let the oldest held read finish. */
		releaseRead() {
			heldReads.shift()?.resolve();
		},
		/** Let the newest held read finish. */
		releaseNewestRead() {
			heldReads.pop()?.resolve();
		},
		releaseReads() {
			holdingReads = false;
			for (const gate of heldReads.splice(0)) gate.resolve();
		},
		holdReplies() {
			holdingReplies = true;
		},
		heldReplies: () => heldReplies.length,
		/** Let the oldest held write reply. */
		releaseReply() {
			heldReplies.shift()?.resolve();
		},
		releaseReplies() {
			holdingReplies = false;
			for (const gate of heldReplies.splice(0)) gate.resolve();
		},
		/**
		 * Hold the next write before it lands, as slow hashing or transport
		 * would. Returns what lets it land.
		 */
		holdNextLanding() {
			const gate = Promise.withResolvers<void>();
			landing = gate;
			return () => gate.resolve();
		},
		/** The outcomes of the next writes, in order; later writes succeed. */
		script(...next: Outcome[]) {
			outcomes.push(...next);
		},
	};
}

async function openPlan(initial: string | undefined = row('A')) {
	const fake = createFakeTable(initial);
	const editor = expectOk(await fake.table.edit('plan'));
	return { ...fake, editor };
}

/** An editor whose only write, of B, failed with `outcome` with nothing waiting. */
async function openFailed(outcome: 'io' | 'unconfirmed' = 'io') {
	const fake = await openPlan();
	const { editor } = fake;
	fake.script(outcome);
	editor.setText(row('B'));
	await until(() => editor.get().save.status !== 'saving');
	const { save } = editor.get();
	if (save.status !== 'failed') throw new Error('expected failed');
	return { ...fake, save };
}

// ============================================================================
// Acquisition
// ============================================================================

test('acquisition reads once; get, subscribers, and settled saves never read or adopt', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	expect(fake.reads()).toBe(1);

	fake.writeElsewhere(row('Elsewhere'));
	const calls: string[] = [];
	const stop = editor.subscribe(() => calls.push('heard'));
	editor.get();
	await flush();
	// No initial delivery, no read, no adoption.
	expect(calls).toEqual([]);
	expect(fake.reads()).toBe(1);
	expect(shown(editor)).toBe('A');

	editor.setText(row('Mine'));
	await until(() => editor.get().save.status === 'idle');
	stop();
	fake.writeElsewhere(row('Elsewhere again'));
	editor.subscribe(() => {})();
	await flush();
	// A settled save requests no read, and nothing follows the file.
	expect(fake.reads()).toBe(1);
	expect(shown(editor)).toBe('Mine');
	expect(calls).toEqual(['heard', 'heard']);
});

test('an aborted acquisition returns at once and opens nothing', async () => {
	const fake = createFakeTable(row('A'));
	const before = new AbortController();
	before.abort();
	expect(
		expectErr(await fake.table.edit('plan', { signal: before.signal })).name,
	).toBe('Aborted');
	expect(fake.reads()).toBe(0);

	fake.holdReads();
	const during = new AbortController();
	const plan = fake.table.edit('plan', { signal: during.signal });
	during.abort();
	expect(expectErr(await plan).name).toBe('Aborted');
	fake.releaseReads();
	await flush();
	expect(fake.reads()).toBe(1);
});

test('missing, unreadable, non-UTF-8, and invalid addresses acquire nothing', async () => {
	const missing = createFakeTable(undefined);
	expect(expectErr(await missing.table.edit('plan')).name).toBe('NotFound');

	const failing = createFakeTable(row('A'));
	failing.failReads(READ_FAILURE);
	expect(expectErr(await failing.table.edit('plan')).name).toBe('Io');

	const binary = createFakeTable(new Uint8Array([0xff, 0xfe]));
	expect(expectErr(await binary.table.edit('plan')).name).toBe('InvalidUtf8');

	const badStem = createFakeTable(row('A'));
	expect(expectErr(await badStem.table.edit('../escape')).name).toBe(
		'InvalidPath',
	);
	expect(badStem.reads()).toBe(0);
});

test('malformed, unsupported, and schema-invalid readable text opens for raw repair', async () => {
	const cases = [
		['---\ntitle: Plan\n', 'NoCanonicalForm'],
		[
			'---\ntitle: !custom Plan\ndone: false\npriority: low\n---\n',
			'NoCanonicalForm',
		],
		['---\ntitle: ""\ndone: false\npriority: low\n---\n', 'Nonconforming'],
	] as const;
	for (const [text, name] of cases) {
		const fake = await openPlan(text);
		const { row: opened } = fake.editor.get();
		if (opened.status !== 'invalid') throw new Error(`expected ${name}`);
		expect(opened.text).toBe(text);
		expect(opened.error.name).toBe(name);
		expect(fake.editor.get().save.status).toBe('idle');

		// Raw repair through the same owner, saved over the existing row.
		fake.editor.setText(row('Fixed'));
		expect(shown(fake.editor)).toBe('Fixed');
		await until(() => fake.editor.get().save.status === 'idle');
		expect(fake.writes).toEqual([row('Fixed')]);
	}
});

test('validity is judged on the complete canonical parse: every declared field checked, unknown metadata kept out', async () => {
	const fake = await openPlan(
		'---\nowner: sam\ntitle: ""\ndone: true\nmeta: {a: 1}\n---\nBody.\n',
	);
	const opened = fake.editor.get().row;
	if (opened.status !== 'invalid' || opened.error.name !== 'Nonconforming')
		throw new Error('expected Nonconforming');
	const { reading } = opened.error;
	expect(reading.issues.map((issue) => issue.field)).toEqual([
		'title',
		'priority',
	]);
	expect(reading.fields).toEqual({ done: true });
	expect(Object.isFrozen(reading.fields)).toBe(true);
	expect(reading.body).toBe('Body.\n');
	expect(reading.parseError).toBeUndefined();
	expect(opened.error.message).toContain('title');
	expect(opened.error.message).toContain('priority is missing');

	// The ordinary row parser reads this title as the string "1", which a
	// string field accepts. The canonical parse refuses the tag, so the row is
	// never valid with fields the editor could not have checked.
	const tagged = '---\ntitle: !!float 1\ndone: false\npriority: low\n---\n';
	const partial = inspectRow(definition.tables.todos, tagged);
	expect(partial.fields.title).toBe('1');
	expect(partial.issues).toEqual([]);
	const disagreement = await openPlan(tagged);
	const read = disagreement.editor.get().row;
	expect(read.status === 'invalid' && read.error.name).toBe('NoCanonicalForm');

	// Aliases the ordinary reader refuses never make a valid row either.
	const uses = Array.from({ length: 60 }, (_, i) => `u${i}: *a`).join('\n');
	const weighted = `---\ntitle: Plan\ndone: false\npriority: low\na: &a x\n${uses}\nb: &b [*a]\nc: *b\nd: *b\n---\n`;
	expect(
		inspectRow(definition.tables.todos, weighted).parseError,
	).toBeDefined();
	const aliased = (await openPlan(weighted)).editor.get().row;
	expect(aliased.status === 'invalid' && aliased.error.name).toBe(
		'NoCanonicalForm',
	);
});

// ============================================================================
// Accepted input
// ============================================================================

test('a whole-row spread keeps unknown metadata and body; omitted keys are deleted', async () => {
	const fake = await openPlan(STYLED);
	const { editor } = fake;
	const opened = editor.get().row;
	if (opened.status !== 'valid') throw new Error('expected a valid row');
	// The acquired text is exact; fields include unknown metadata.
	expect(opened.text).toBe(STYLED);
	expect(opened.fields).toEqual({
		owner: 'sam',
		title: 'Plan',
		meta: { b: 1, a: [true, null] },
		priority: 'normal',
		done: false,
	});

	fake.holdReplies();
	const { owner: _dropped, ...kept } = opened.fields;
	expectOk(
		editor.set({ fields: { ...kept, title: 'Plan B' }, body: opened.body }),
	);
	const expected =
		'---\n"title": "Plan B"\n"done": false\n"priority": "normal"\n"meta": {"a": [true, null], "b": 1}\n---\nBody A.\n';
	// Public before the write settles, as one capture.
	const accepted = editor.get();
	expect(accepted.save.status).toBe('saving');
	if (accepted.row.status !== 'valid') throw new Error('expected valid');
	expect(accepted.row.text).toBe(expected);
	expect(accepted.row.fields).toEqual({
		title: 'Plan B',
		done: false,
		priority: 'normal',
		meta: { a: [true, null], b: 1 },
	});
	expect(accepted.row.body).toBe('Body A.\n');
	expect(Object.isFrozen(accepted.row.fields)).toBe(true);
	expect(Object.isFrozen(accepted)).toBe(true);
	expect(editor.get()).toBe(accepted);

	await flush();
	fake.releaseReplies();
	await until(() => editor.get().save.status === 'idle');
	expect(fake.writes).toEqual([expected]);
	// An existing-row replacement, unguarded, never an overwrite.
	expect(fake.applied).toMatchObject([{ kind: 'replace', path: PATH }]);
	expect(fake.applied[0]).not.toHaveProperty('expectedSha256');
});

test('a caller mutating its objects after set changes neither held input nor queued bytes', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.holdReplies();
	editor.setText(row('A1'));
	const tags = ['one'];
	const fields = { title: 'B', done: false, priority: 'normal', tags };
	expectOk(editor.set({ fields, body: 'Body.\n' }));
	const accepted = editor.get().row;
	fields.title = 'mutated';
	tags.push('two');
	expect(editor.get().row).toBe(accepted);
	if (accepted.status !== 'valid') throw new Error('expected valid');
	expect(accepted.fields.title).toBe('B');
	expect(accepted.fields.tags).toEqual(['one']);
	fake.releaseReplies();
	await until(() => editor.get().save.status === 'idle');
	expect(fake.writes.at(-1)).toBe(row('B', 'Body.\n', '"tags": ["one"]\n'));
});

test('set reads only fields and body: a passed-back row cannot inject its status or text', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	const current = editor.get().row;
	if (current.status !== 'valid') throw new Error('expected valid');
	const forged = {
		...current,
		status: 'invalid',
		text: '---\n"title": "Injected"\n---\n',
		error: 'ignored',
	} as unknown as typeof current;
	expectOk(editor.set(forged));
	const accepted = editor.get().row;
	expect(accepted.status).toBe('valid');
	expect(accepted.text).toBe(row('A'));
	await until(() => editor.get().save.status === 'idle');
	expect(fake.writes).toEqual([row('A')]);
});

test('unrepresentable input is refused synchronously with no input or publication change', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	const before = editor.get();
	const nan = expectErr(
		editor.set({ fields: { title: 'A', done: Number.NaN }, body: '' }),
	);
	expect(nan.name).toBe('Unrepresentable');
	expect(nan.refusal.path).toEqual(['done']);
	// The codec owns shape refusals of untyped input.
	const body = expectErr(
		editor.set({
			fields: { title: 'A' },
			body: 42,
		} as unknown as Parameters<Editor['set']>[0]),
	);
	expect(body.name).toBe('Unrepresentable');
	expect(body.refusal).toEqual({
		reason: 'The body is not a string',
		path: ['body'],
	});
	expect(
		expectErr(
			editor.set({ body: '' } as unknown as Parameters<Editor['set']>[0]),
		).refusal.reason,
	).toBe('The fields are not a plain object');
	for (const missing of [null, undefined]) {
		const refused = expectErr(
			editor.set(missing as unknown as Parameters<Editor['set']>[0]),
		);
		expect(refused.name).toBe('Unrepresentable');
		expect(refused.refusal.reason).toBe('The document is not an object');
	}
	expect(editor.get()).toBe(before);
	await flush();
	expect(fake.applied).toHaveLength(0);
});

test('a refusal while A is active and B pending leaves both the snapshot and the queue as they were', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.holdReplies();
	editor.setText(row('A1'));
	await flush();
	editor.setText(row('B'));
	const before = editor.get();
	expectErr(editor.set({ fields: { title: 'X', done: Number.NaN }, body: '' }));
	expectErr(editor.set(null as unknown as Parameters<Editor['set']>[0]));
	expect(editor.get()).toBe(before);
	fake.releaseReplies();
	await until(() => editor.get().save.status === 'idle');
	expect(fake.writes).toEqual([row('A1'), row('B')]);
});

test('schema-invalid representable input is accepted, saved, and kept for repair', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	expectOk(
		editor.set({
			fields: { title: '', done: false, priority: 'urgent' },
			body: 'Body.\n',
		}),
	);
	const held = editor.get().row;
	if (held.status !== 'invalid') throw new Error('expected invalid');
	expect(held.error.name).toBe('Nonconforming');
	const saved =
		'---\n"title": ""\n"done": false\n"priority": "urgent"\n---\nBody.\n';
	expect(held.text).toBe(saved);
	await until(() => editor.get().save.status === 'idle');
	expect(fake.writes).toEqual([saved]);
	expect(editor.get().row).toBe(held);
});

test('raw text is accepted exactly, interpreted completely, and published as given', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	editor.setText(STYLED);
	const accepted = editor.get().row;
	if (accepted.status !== 'valid') throw new Error('expected valid');
	expect(accepted.text).toBe(STYLED);
	expect(accepted.fields.owner).toBe('sam');
	expect(accepted.body).toBe('Body A.\n');

	editor.setText('---\nbroken: [\n---\n');
	expect(editor.get().row.status).toBe('invalid');
	await until(() => editor.get().save.status === 'idle');
	expect(fake.writes).toEqual([STYLED, '---\nbroken: [\n---\n']);
});

// ============================================================================
// Publication
// ============================================================================

test('A active, B then C pending: A publishes, then C; B is never submitted; no idle gap', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	const { saves } = record(editor);
	fake.holdReplies();
	editor.setText(row('A1'));
	await flush();
	editor.setText(row('B'));
	editor.setText(row('C'));
	expect(shown(editor)).toBe('C');
	expect(fake.heldReplies()).toBe(1);

	fake.releaseReply();
	await until(() => fake.heldReplies() === 1);
	expect(editor.get().save.status).toBe('saving');
	fake.releaseReplies();
	await until(() => editor.get().save.status === 'idle');
	expect(fake.writes).toEqual([row('A1'), row('C')]);
	expect(saves()).toEqual(['saving', 'saving', 'saving', 'idle']);
});

test("A's receipt with B public leaves B public: no rollback and no mixture", async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.holdReplies();
	editor.setText(row('A1', 'A body.\n'));
	await flush();
	expectOk(
		editor.set({
			fields: { title: 'B', done: true, priority: 'high' },
			body: 'B body.\n',
		}),
	);
	const b = editor.get().row;
	fake.releaseReply();
	await until(() => fake.applied.length === 2);
	expect(editor.get().row).toBe(b);
	if (b.status !== 'valid') throw new Error('expected valid');
	expect(b.text).toContain('"title": "B"');
	expect(b.body).toBe('B body.\n');
	fake.releaseReplies();
	await until(() => editor.get().save.status === 'idle');
	expect(editor.get().row).toBe(b);
});

for (const outcome of ['io', 'unconfirmed'] as const)
	test(`A ${outcome === 'io' ? 'failing' : 'unconfirmed'} with B then C waiting: C is written next and its success is the outcome`, async () => {
		const fake = await openPlan();
		const { editor } = fake;
		const { saves } = record(editor);
		fake.script(outcome);
		fake.holdReplies();
		editor.setText(row('A1'));
		await flush();
		editor.setText(row('B'));
		editor.setText(row('C'));
		fake.releaseReplies();
		await until(() => editor.get().save.status !== 'saving');
		// Nothing paused: the failure consumed the waiting input and continued.
		expect(fake.attempts).toEqual([row('A1'), row('C')]);
		expect(fake.disk()).toBe(row('C'));
		expect(editor.get().save.status).toBe('idle');
		expect(saves()).not.toContain('failed');
		expectOk(await editor.waitForSaves());
	});

for (const outcome of ['io', 'unconfirmed'] as const)
	test(`a write ${outcome === 'io' ? 'failing' : 'unconfirmed'} with nothing waiting ends failed without retrying; the next input saves again`, async () => {
		const fake = await openFailed(outcome);
		const { editor, save } = fake;
		expect(save.error.name).toBe(outcome === 'io' ? 'Io' : 'Unconfirmed');
		expect(shown(editor)).toBe('B');
		await flush();
		// No retry loop: the failure stays reported and nothing is attempted.
		expect(fake.applied).toHaveLength(1);
		expect(editor.get().save).toBe(save);

		// Typing after the failure starts a write at once.
		editor.setText(row('C'));
		expect(shown(editor)).toBe('C');
		expect(editor.get().save.status).toBe('saving');
		const active = editor.get().save;
		expect('error' in active && active.error).toBe(save.error);
		await until(() => editor.get().save.status === 'idle');
		expect(fake.attempts).toEqual([row('B'), row('C')]);
		expect(fake.disk()).toBe(row('C'));
		// A retry while idle starts nothing.
		editor.retry();
		await flush();
		expect(fake.applied).toHaveLength(2);
	});

test('a failed attempt remains visible while newer pending text saves; success clears it', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.script('io');
	fake.holdReplies();
	editor.setText(row('A1'));
	await flush();
	editor.setText(row('B'));
	fake.releaseReply();
	await until(() => fake.applied.length === 2);
	const saving = editor.get().save;
	expect(saving.status).toBe('saving');
	expect('error' in saving && saving.error?.name).toBe('Io');
	expect(shown(editor)).toBe('B');
	// More typing keeps the error visible without changing the active write.
	editor.setText(row('C'));
	expect(editor.get().save).toBe(saving);
	fake.releaseReply();
	await until(() => fake.applied.length === 3);
	expect(editor.get().save).toEqual({ status: 'saving' });
	fake.releaseReplies();
	expectOk(await editor.waitForSaves());
	expect(editor.get().save).toEqual({ status: 'idle' });
	expect(fake.disk()).toBe(row('C'));
});

test('a write that settles while a later one waits starts it before anything is heard; input after that waits for it', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.holdReplies();
	editor.setText(row('A1'));
	await flush();
	editor.setText(row('B'));
	const { saves } = record(editor);
	fake.releaseReply();
	// B started as A settled; no subscriber heard A's settlement in between.
	await until(() => fake.applied.length === 2);
	expect(saves()).toEqual([]);
	editor.setText(row('C'));
	fake.releaseReplies();
	await until(() => editor.get().save.status === 'idle');
	// B was already running, so it is written, then C after it.
	expect(fake.attempts).toEqual([row('A1'), row('B'), row('C')]);
	expect(fake.disk()).toBe(row('C'));
});

test('a subscriber answering a failure with new input starts a write that the settlement does not clear', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.holdReplies();
	editor.setText(row('A1'));
	await flush();
	// Waiting input with no exact bytes fails its turn without writing.
	editor.setText(`${row('B')}\uD800`);
	let answered = false;
	editor.subscribe(() => {
		if (answered || editor.get().save.status !== 'failed') return;
		answered = true;
		editor.setText(row('C'));
	});
	fake.releaseReplies();
	expectOk(await editor.waitForSaves());
	expect(answered).toBe(true);
	expect(fake.attempts).toEqual([row('A1'), row('C')]);
	expect(editor.get().save.status).toBe('idle');
});

test('retry after an uncertain write is a new attempt of the same text, never a confirmation', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.script('unconfirmed', 'unconfirmed');
	editor.setText(row('B'));
	await until(() => editor.get().save.status !== 'saving');
	const first = editor.get().save;
	expect(first.status === 'failed' && first.error.name).toBe('Unconfirmed');
	// The file holds B; the editor still reports uncertainty.
	expect(fake.disk()).toBe(row('B'));

	editor.retry();
	await until(() => editor.get().save.status !== 'saving');
	const second = editor.get().save;
	expect(second).not.toBe(first);
	expect(second.status === 'failed' && second.error.name).toBe('Unconfirmed');
	editor.retry();
	await until(() => editor.get().save.status === 'idle');
	expect(fake.applied.map((change) => change.kind)).toEqual([
		'replace',
		'replace',
		'replace',
	]);
	expect(fake.writes).toEqual([row('B'), row('B'), row('B')]);
});

test('raw text UTF-8 cannot encode exactly is held and never written lossily; the next encodable input saves', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	const lone = `${row('A')}\uD800`;
	editor.setText(lone);
	const held = editor.get();
	if (held.row.status !== 'invalid') throw new Error('expected invalid');
	expect(held.row.text).toBe(lone);
	expect(held.row.error.name).toBe('Unencodable');
	if (held.save.status !== 'failed') throw new Error('expected failed');
	expect(held.save.error.name).toBe('Unencodable');
	expectErr(await editor.waitForSaves());
	await flush();
	expect(fake.applied).toHaveLength(0);

	// Retrying the same text fails again without writing.
	editor.retry();
	const again = editor.get().save;
	expect(again.status === 'failed' && again.error.name).toBe('Unencodable');
	expect(fake.applied).toHaveLength(0);

	editor.setText(row('Fixed'));
	expect(shown(editor)).toBe('Fixed');
	expect(editor.get().save.status).toBe('saving');
	expectOk(await editor.waitForSaves());
	expect(fake.writes).toEqual([row('Fixed')]);
});

test('A active with unencodable B pending: B is public; A stays saving; B fails on its turn with no idle gap', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	const { saves } = record(editor);
	fake.holdReplies();
	editor.setText(row('A1'));
	await flush();
	const lone = `${row('B')}\uDC00`;
	editor.setText(lone);
	const pending = editor.get();
	expect(pending.row.text).toBe(lone);
	expect(pending.save.status).toBe('saving');

	fake.releaseReplies();
	await until(() => editor.get().save.status !== 'saving');
	const { save } = editor.get();
	expect(save.status === 'failed' && save.error.name).toBe('Unencodable');
	expect(fake.writes).toEqual([row('A1')]);
	expect(saves()).toEqual(['saving', 'saving', 'failed']);
});

test("A failing with unencodable B waiting reports B's Unencodable: the latest attempt's outcome", async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.script('io');
	fake.holdReplies();
	editor.setText(row('A1'));
	await flush();
	editor.setText(`${row('B')}\uD800`);
	fake.releaseReplies();
	await until(() => editor.get().save.status !== 'saving');
	const { save } = editor.get();
	expect(save.status === 'failed' && save.error.name).toBe('Unencodable');
	expect(expectErr(await editor.waitForSaves()).name).toBe('Unencodable');
	expect(fake.attempts).toEqual([row('A1')]);
});

test('storage that throws settles as uncertain, never stuck saving; the next input saves again', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.script('throw');
	editor.setText(row('B'));
	await until(() => editor.get().save.status !== 'saving');
	const { save } = editor.get();
	if (save.status !== 'failed') throw new Error('expected failed');
	expect(save.error.name).toBe('Unconfirmed');
	editor.setText(row('C'));
	expectOk(await editor.waitForSaves());
	expect(fake.writes).toEqual([row('B'), row('C')]);
});

test('a row deleted before publication is NotFound, never recreated by any later write, and its input stays public', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.writeElsewhere(undefined);
	editor.setText(row('B'));
	expect(expectErr(await editor.waitForSaves()).name).toBe('NotFound');
	expect(shown(editor)).toBe('B');

	// Explicit retry and later typing each attempt again; neither recreates.
	editor.retry();
	expect(expectErr(await editor.waitForSaves()).name).toBe('NotFound');
	fake.holdReplies();
	editor.setText(row('C'));
	editor.setText(row('D'));
	fake.releaseReplies();
	expect(expectErr(await editor.waitForSaves()).name).toBe('NotFound');
	expect(fake.attempts).toEqual([row('B'), row('B'), row('C'), row('D')]);
	expect(fake.disk()).toBeUndefined();
	expect(fake.writes).toEqual([]);
	expect(shown(editor)).toBe('D');
});

test('an earlier write that lands after a later save stays: nothing orders them', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	// The editor's write is held before it lands, as slow hashing would.
	const land = fake.holdNextLanding();
	editor.setText(row('Mine'));
	await until(() => fake.applied.length === 1);
	expectOk(await fake.table.replace('plan', row('Later'), {}));
	expect(fake.disk()).toBe(row('Later'));
	land();
	// It lands over the later save and reports success, not a refusal.
	expectOk(await editor.waitForSaves());
	expect(fake.disk()).toBe(row('Mine'));
	expect(fake.writes).toEqual([row('Later'), row('Mine')]);
});

test('listener exceptions are isolated, never fail a save, and delivery is never reentrant', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	let depth = 0;
	let maxDepth = 0;
	let thrown = 0;
	const titles: unknown[] = [];
	editor.subscribe(() => {
		thrown += 1;
		throw new Error('a broken view');
	});
	editor.subscribe(() => {
		depth += 1;
		maxDepth = Math.max(maxDepth, depth);
		titles.push(shown(editor));
		if (titles.length === 1) editor.setText(row('Nested'));
		depth -= 1;
	});
	fake.holdReplies();
	editor.setText(row('B'));
	expect(maxDepth).toBe(1);
	expect(titles.slice(0, 2)).toEqual(['B', 'Nested']);
	fake.releaseReplies();
	expectOk(await editor.waitForSaves());
	expect(editor.get().save.status).toBe('idle');
	expect(fake.writes).toEqual([row('B'), row('Nested')]);
	// The broken view heard every change, through both writes.
	expect(thrown).toBe(3);
});

test('unsubscribing ends only that subscription and leaves publication running', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	const calls: string[] = [];
	const stopOne = editor.subscribe(() => calls.push('one'));
	const stopTwo = editor.subscribe(() => calls.push('two'));
	fake.holdReplies();
	editor.setText(row('Mine'));
	expect(calls).toEqual(['one', 'two']);
	stopOne();
	stopOne();
	stopTwo();
	fake.releaseReplies();
	await until(() => editor.get().save.status === 'idle');
	expect(calls).toEqual(['one', 'two']);
	expect(fake.disk()).toBe(row('Mine'));
});

// ============================================================================
// waitForSaves
// ============================================================================

test('waitForSaves resolves Ok at once when idle and waits through consecutive writes, input accepted during them included', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	expectOk(await editor.waitForSaves());

	fake.holdReplies();
	editor.setText(row('A1'));
	const waiting = editor.waitForSaves();
	await flush();
	editor.setText(row('B'));
	fake.releaseReply();
	// A settled, but B is running.
	await until(() => fake.applied.length === 2);
	expect(await hasSettled(waiting)).toBe(false);
	fake.releaseReplies();
	expectOk(await waiting);
	expect(editor.get().save.status).toBe('idle');
	expect(fake.disk()).toBe(row('B'));
});

test('waitForSaves returns the latest attempt: a failure the waiting input replaced is Ok once that input saves', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.script('io');
	fake.holdReplies();
	editor.setText(row('A1'));
	const waiting = editor.waitForSaves();
	await flush();
	editor.setText(row('B'));
	fake.releaseReplies();
	expectOk(await waiting);
	expect(fake.disk()).toBe(row('B'));
});

test('waitForSaves returns a failure with nothing waiting at once and never retries it', async () => {
	const fake = await openFailed();
	const { editor, save } = fake;
	expect(expectErr(await editor.waitForSaves())).toBe(save.error);
	expect(expectErr(await editor.waitForSaves())).toBe(save.error);
	await flush();
	expect(fake.applied).toHaveLength(1);
});

test('waitForSaves waits through writes a subscriber starts as each settles, and returns the last outcome', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	const answers = [row('Second'), row('Third')];
	fake.script('ok', 'ok', 'io');
	editor.subscribe(() => {
		const { save } = editor.get();
		// Each settled write is answered with the next input, from inside the
		// delivery that reports it.
		if (save.status !== 'idle') return;
		const next = answers.shift();
		if (next !== undefined) editor.setText(next);
	});
	editor.setText(row('First'));
	const error = expectErr(await editor.waitForSaves());
	expect(error.name).toBe('Io');
	expect(fake.attempts).toEqual([row('First'), row('Second'), row('Third')]);
	expect(editor.get().save.status).toBe('failed');
});

// ============================================================================
// reload
// ============================================================================

test('reload adopts the file over failed input and clears the failure without writing', async () => {
	const fake = await openFailed();
	const { editor } = fake;
	fake.writeElsewhere(STYLED);
	const reads = fake.reads();
	expectOk(await editor.reload());
	expect(fake.reads()).toBe(reads + 1);
	const adopted = editor.get();
	expect(adopted.save.status).toBe('idle');
	if (adopted.row.status !== 'valid') throw new Error('expected valid');
	// The exact text, with its comment and unknown metadata.
	expect(adopted.row.text).toBe(STYLED);
	expect(adopted.row.fields.owner).toBe('sam');
	await flush();
	expect(fake.applied).toHaveLength(1);

	// Saving goes on from the adopted row.
	editor.setText(row('Next'));
	await until(() => editor.get().save.status === 'idle');
	expect(fake.disk()).toBe(row('Next'));
});

test('reload adopts malformed text exactly for raw repair', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	const malformed = '---\nbroken: [\n---\n\r\nBody\r\n';
	fake.writeElsewhere(malformed);
	expectOk(await editor.reload());
	const adopted = editor.get().row;
	if (adopted.status !== 'invalid') throw new Error('expected invalid');
	expect(adopted.text).toBe(malformed);
	expect(adopted.error.name).toBe('NoCanonicalForm');
});

test('reload waits for the running write, then reads the file it left', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.holdReplies();
	editor.setText(row('Mine'));
	const reads = fake.reads();
	const reloading = editor.reload();
	await flush();
	expect(fake.reads()).toBe(reads);
	fake.writeElsewhere(row('Theirs'));
	fake.releaseReplies();
	expectOk(await reloading);
	expect(fake.reads()).toBe(reads + 1);
	expect(shown(editor)).toBe('Theirs');
	expect(editor.get().save.status).toBe('idle');
});

test('a failed reload read leaves the row and save state exactly as they were', async () => {
	const fake = await openFailed();
	const { editor } = fake;
	const before = editor.get();
	for (const [lose, name] of [
		[() => fake.failReads(READ_FAILURE), 'Io'],
		[() => fake.writeElsewhere(undefined), 'NotFound'],
		[() => fake.writeElsewhere(new Uint8Array([0xff])), 'InvalidUtf8'],
	] as const) {
		lose();
		expect(expectErr(await editor.reload()).name).toBe(name);
		// Readability never hides the input or its failure.
		expect(editor.get()).toBe(before);
		fake.failReads(undefined);
	}
	expect(fake.applied).toHaveLength(1);
});

test('typing during a reload read returns InputChanged; the typed input stands and saves', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.writeElsewhere(row('Disk'));
	fake.holdReads();
	const reloading = editor.reload();
	expect(fake.heldReads()).toBe(1);
	editor.setText(row('Typed'));
	fake.releaseReads();
	expect(expectErr(await reloading).name).toBe('InputChanged');
	expect(shown(editor)).toBe('Typed');
	await until(() => editor.get().save.status === 'idle');
	expect(fake.disk()).toBe(row('Typed'));
});

test('typing while reload waits for a write returns InputChanged without reading', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.holdReplies();
	editor.setText(row('A1'));
	const reads = fake.reads();
	const reloading = editor.reload();
	editor.setText(row('B'));
	fake.releaseReplies();
	expect(expectErr(await reloading).name).toBe('InputChanged');
	expect(fake.reads()).toBe(reads);
	expect(shown(editor)).toBe('B');
	expect(fake.disk()).toBe(row('B'));
});

test('typing after a failure, or a retry, during a reload read returns InputChanged; that input is saved', async () => {
	for (const during of ['typing', 'retry'] as const) {
		const fake = await openFailed();
		const { editor } = fake;
		fake.writeElsewhere(row('Disk'));
		fake.holdReads();
		const reloading = editor.reload();
		if (during === 'typing') editor.setText(row('C'));
		else editor.retry();
		fake.releaseReads();
		expect(expectErr(await reloading).name).toBe('InputChanged');
		expectOk(await editor.waitForSaves());
		const kept = during === 'typing' ? 'C' : 'B';
		expect(shown(editor)).toBe(kept);
		expect(fake.disk()).toBe(row(kept));
	}
});

test('retyping the same text during a reload read still returns InputChanged', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.writeElsewhere(row('Disk'));
	fake.holdReads();
	const reloading = editor.reload();
	editor.setText(row('A'));
	fake.releaseReads();
	expect(expectErr(await reloading).name).toBe('InputChanged');
	expect(shown(editor)).toBe('A');
});

test('a synchronous failed retry while reload waits for writes preserves input and prevents adoption', async () => {
	const fake = await openPlan();
	const { editor } = fake;
	fake.holdReplies();
	editor.setText(row('A'));
	await until(() => fake.writes.length === 1);
	editor.setText('\uD800');
	const reloading = editor.reload();
	let retried = false;
	const unsubscribe = editor.subscribe(() => {
		if (editor.get().save.status !== 'failed' || retried) return;
		retried = true;
		editor.retry();
	});
	const reads = fake.reads();
	fake.releaseReplies();
	expect(expectErr(await reloading).name).toBe('InputChanged');
	expect(retried).toBe(true);
	expect(editor.get().row.text).toBe('\uD800');
	expect(editor.get().save.status).toBe('failed');
	expect(fake.reads()).toBe(reads);
	unsubscribe();
});

test('overlapping reloads: the latest call decides, and the earlier one settles with its result', async () => {
	for (const order of ['earlier first', 'latest first'] as const) {
		const fake = await openPlan();
		const { editor } = fake;
		fake.writeElsewhere(row('Older'));
		fake.holdReads();
		const earlier = editor.reload();
		fake.writeElsewhere(row('Newer'));
		const latest = editor.reload();
		expect(fake.heldReads()).toBe(2);
		if (order === 'earlier first') fake.releaseRead();
		else fake.releaseNewestRead();
		await flush();
		// The earlier read never adopts, whichever finishes first.
		expect(shown(editor)).toBe(order === 'earlier first' ? 'A' : 'Newer');
		fake.releaseReads();
		expectOk(await earlier);
		expectOk(await latest);
		expect(shown(editor)).toBe('Newer');
	}
});

// ============================================================================
// A real folder
// ============================================================================

test('over a real folder: acquire styled source, replace canonically, ignore outside changes until reload, never recreate', async () => {
	const root = await realpath(await scratch('epicenter-row-editor-'));
	const folder = expectOk(
		await openFolder({
			root,
			definition,
			git: {
				author: { name: 'Test', email: 'test@example.test' },
				commitOnEdit: false,
			},
		}),
	);
	try {
		expectOk(await folder.files.create(PATH, STYLED));
		const editor = expectOk(await folder.tables.todos.edit('plan'));
		const stop = editor.subscribe(() => {});

		const opened = editor.get().row;
		if (opened.status !== 'valid') throw new Error('expected valid');
		expectOk(
			editor.set({
				fields: { ...opened.fields, title: 'Plan B', done: true },
				body: opened.body,
			}),
		);
		expectOk(await editor.waitForSaves());
		const disk = await readFile(join(root, PATH), 'utf8');
		expect(disk).toBe(
			'---\n"title": "Plan B"\n"done": true\n"priority": "normal"\n"meta": {"a": [true, null], "b": 1}\n"owner": "sam"\n---\nBody A.\n',
		);
		expect(editor.get().row.text).toBe(disk);

		// A save through this folder hints; the editor does not follow it.
		expectOk(await folder.files.overwrite(PATH, row('Hinted')));
		await flush();
		expect(shown(editor)).toBe('Plan B');
		expectOk(await editor.reload());
		expect(shown(editor)).toBe('Hinted');

		await writeFile(join(root, PATH), row('From elsewhere'));
		expectOk(await editor.reload());
		expect(shown(editor)).toBe('From elsewhere');

		// Deleted outside the folder, then edited: replace refuses to recreate.
		await rm(join(root, PATH));
		editor.setText(row('Mine'));
		const failure = expectErr(await editor.waitForSaves());
		expect(failure.name).toBe('NotFound');
		expect(expectOk(await folder.tables.todos.get('plan'))).toBeUndefined();
		expect(expectErr(await editor.reload()).name).toBe('NotFound');
		expect(shown(editor)).toBe('Mine');

		// Recreated: reload adopts it and discards the held input and failure.
		await writeFile(join(root, PATH), row('Recreated'));
		expectOk(await editor.reload());
		expect(shown(editor)).toBe('Recreated');
		expect(editor.get().save.status).toBe('idle');

		// A closed folder refuses the next attempt and the next read.
		await folder.close();
		editor.setText(row('After close'));
		expect(expectErr(await editor.waitForSaves()).name).toBe('Closed');
		expect(expectErr(await editor.reload()).name).toBe('Closed');
		expect(shown(editor)).toBe('After close');
		stop();
	} finally {
		await folder.close();
		await rm(root, { recursive: true, force: true });
	}
});
