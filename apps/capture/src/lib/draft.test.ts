/**
 * Capture Draft Tests
 *
 * Drives the real draft runes module against a store whose writes and reads
 * the test holds open, so each race is played in a fixed order.
 *
 * Key behaviors:
 * - A save writes the exact buffer against the captured baseline; typing
 *   during the save stays dirty and saves next
 * - Save B racing typing C and an outside write D: B is acknowledged, C is
 *   kept, the file is reread, and D is shown as a conflict
 * - An observation during a save is not applied; the reread decides
 * - A clean draft adopts an outside change and writes nothing; a dirty one
 *   keeps its buffer and pauses saving
 * - Removed and unreadable are different conflicts with different choices
 * - A failed save and a store that throws both keep the buffer for a retry
 * - Unsent thought text and refused capture text count as unsettled
 * - A thought edit begun before the buffer changed is refused, text kept
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { captureVersion } from '@epicenter/folder';
import type {
	CaptureEntry,
	Current,
	Draft,
	DraftStore,
} from './draft.svelte.ts';

const { createDraft } = await import('./draft.svelte.ts');

const PATH = 'captures/one.md';
const head = '---\ncapturedAt: 2026-10-01T02:30:00.000Z\n---\n';
const A = `${head}\nA\n\n## Thoughts\n\n- first\n- second\n`;

async function entryFor(source: string): Promise<CaptureEntry> {
	return {
		path: PATH,
		stem: 'one',
		source,
		version: await captureVersion(new TextEncoder().encode(source)),
		fields: { capturedAt: '2026-10-01T02:30:00.000Z' as never },
		body: '',
		issues: undefined,
	};
}

function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

/** A file on a fake disk, with conditional writes like the folder's. */
async function setup(initial = A) {
	let disk: string | undefined = initial;
	let unreadable: string | undefined;
	let hold: ReturnType<typeof gate> | undefined;
	let failure: { name: string; message: string } | Error | undefined;
	const writes: { against: string; source: string }[] = [];
	const store: DraftStore = {
		async write(baseline, source) {
			writes.push({ against: baseline.source, source });
			await hold?.opened;
			if (failure instanceof Error) throw failure;
			if (failure) return { data: null, error: failure };
			if (disk !== baseline.source)
				return {
					data: null,
					error: { name: 'Conflict', message: 'changed after it was read' },
				};
			disk = source;
			return { data: await entryFor(source), error: null };
		},
		async read(): Promise<Current> {
			if (unreadable !== undefined)
				return { kind: 'unreadable', message: unreadable };
			return disk === undefined
				? { kind: 'removed' }
				: { kind: 'present', entry: await entryFor(disk) };
		},
		async recreate(_path, source) {
			await hold?.opened;
			if (disk !== undefined)
				return { data: null, error: { name: 'Conflict', message: 'exists' } };
			disk = source;
			return { data: await entryFor(source), error: null };
		},
	};
	const saved: string[] = [];
	const draft = createDraft(store, await entryFor(initial), {
		onSaved: (entry) => saved.push(entry.source),
		batchMs: 60_000,
	});
	return {
		draft,
		writes,
		saved,
		get disk() {
			return disk;
		},
		outside(source: string | undefined) {
			disk = source;
		},
		holdWrites() {
			hold = gate();
			return hold;
		},
		fail(next: typeof failure) {
			failure = next;
		},
		unreadable(message: string | undefined) {
			unreadable = message;
		},
	};
}

const B = A.replace('\nA\n', '\nB\n');
const C = A.replace('\nA\n', '\nBC\n');
const D = A.replace('\nA\n', '\nD from outside\n');

test('a save writes the exact buffer; typing during it stays dirty and saves next', async () => {
	const file = await setup();
	const held = file.holdWrites();
	file.draft.inputSource(B);
	const saving = file.draft.save();
	file.draft.inputSource(C);
	held.open();
	await saving;

	expect(file.writes[0]).toEqual({ against: A, source: B });
	expect(file.draft.baseline.source).toBe(B);
	expect(file.draft.buffer).toBe(C);
	expect(file.draft.dirty).toBe(true);
	expect(file.draft.saveState.kind).toBe('saved');

	await file.draft.save();
	expect(file.writes[1]).toEqual({ against: B, source: C });
	expect(file.disk).toBe(C);
	expect(file.draft.dirty).toBe(false);
});

test('save B, typing C, outside write D after B landed: B acknowledged, C kept, D shown', async () => {
	const file = await setup();
	const held = file.holdWrites();
	file.draft.inputSource(B);
	const saving = file.draft.save();
	file.draft.inputSource(C);
	// The folder hints while the save is still running; the listing it carried
	// is not trusted.
	file.draft.observe({ kind: 'present', entry: await entryFor(A) });
	expect(file.draft.buffer).toBe(C);
	held.open();
	await Bun.sleep(0);
	// B is on disk; another program replaces it before the draft rereads.
	const reread = store_settled(file, D);
	await saving;
	await reread;

	expect(file.saved).toEqual([B]);
	expect(file.draft.baseline.source).toBe(B);
	expect(file.draft.buffer).toBe(C);
	const state = file.draft.saveState;
	expect(state.kind).toBe('conflict');
	if (state.kind !== 'conflict' || state.current.kind !== 'present') return;
	expect(state.current.entry.source).toBe(D);
	expect(file.disk).toBe(D);

	// Saving is paused: more typing writes nothing.
	file.draft.inputSource(`${C}more`);
	await file.draft.save();
	expect(file.writes).toHaveLength(1);
});

/** Replace the disk as soon as the pending write has landed. */
async function store_settled(
	file: Awaited<ReturnType<typeof setup>>,
	next: string,
) {
	while (file.disk !== B) await Bun.sleep(0);
	file.outside(next);
}

test('an outside write that lands before the save conflicts and writes nothing', async () => {
	const file = await setup();
	file.draft.inputSource(B);
	file.outside(D);
	await file.draft.save();

	expect(file.disk).toBe(D);
	expect(file.saved).toEqual([]);
	expect(file.draft.buffer).toBe(B);
	const state = file.draft.saveState;
	expect(state.kind === 'conflict' && state.current.kind).toBe('present');
});

test('a clean draft adopts an outside change and writes nothing', async () => {
	const file = await setup();
	file.draft.observe({ kind: 'present', entry: await entryFor(D) });
	expect(file.draft.buffer).toBe(D);
	expect(file.draft.dirty).toBe(false);
	expect(file.draft.saveState.kind).toBe('saved');
	expect(file.writes).toEqual([]);
});

test('a dirty draft keeps its buffer when the file changes, then each choice does one thing', async () => {
	const file = await setup();
	file.draft.inputSource(B);
	file.outside(D);
	file.draft.observe({ kind: 'present', entry: await entryFor(D) });
	expect(file.draft.buffer).toBe(B);
	expect(file.draft.saveState.kind).toBe('conflict');
	expect(file.writes).toEqual([]);

	// Save mine against the version I reviewed.
	await file.draft.saveMine();
	expect(file.writes).toEqual([{ against: D, source: B }]);
	expect(file.disk).toBe(B);
	expect(file.draft.saveState.kind).toBe('saved');

	// Load saved drops my input instead.
	file.draft.inputSource(C);
	file.outside(D);
	file.draft.observe({ kind: 'present', entry: await entryFor(D) });
	file.draft.loadSaved();
	expect(file.draft.buffer).toBe(D);
	expect(file.draft.dirty).toBe(false);
	expect(file.disk).toBe(D);
});

test('saving mine over a file that changed again conflicts again', async () => {
	const file = await setup();
	file.draft.inputSource(B);
	file.draft.observe({ kind: 'present', entry: await entryFor(D) });
	file.outside('changed twice');
	await file.draft.saveMine();
	expect(file.disk).toBe('changed twice');
	const state = file.draft.saveState;
	expect(
		state.kind === 'conflict' &&
			state.current.kind === 'present' &&
			state.current.entry.source,
	).toBe('changed twice');
	expect(file.draft.buffer).toBe(B);
});

test('a removed file with a dirty draft can be written back; a clean one is let go', async () => {
	const dirty = await setup();
	dirty.draft.inputSource(B);
	dirty.outside(undefined);
	await dirty.draft.save();
	const state = dirty.draft.saveState;
	expect(state.kind === 'conflict' && state.current.kind).toBe('removed');
	expect(dirty.draft.buffer).toBe(B);
	await dirty.draft.saveMine();
	expect(dirty.disk).toBe(B);
	expect(dirty.draft.saveState.kind).toBe('saved');
	expect(dirty.draft.dirty).toBe(false);

	const clean = await setup();
	clean.draft.observe({ kind: 'removed' });
	expect(clean.draft.gone).toBe(true);
	expect(clean.draft.unsettled).toBe(false);
});

test('an unreadable file is not treated as removed and cannot be overwritten', async () => {
	const file = await setup();
	file.draft.inputSource(B);
	file.outside(D);
	file.unreadable('not valid UTF-8 text');
	await file.draft.save();
	const state = file.draft.saveState;
	expect(state.kind === 'conflict' && state.current).toEqual({
		kind: 'unreadable',
		message: 'not valid UTF-8 text',
	});
	await file.draft.saveMine();
	expect(file.disk).toBe(D);
	expect(file.draft.buffer).toBe(B);

	// Once it reads again, the draft shows it as a present conflict.
	file.unreadable(undefined);
	await file.draft.check();
	const next = file.draft.saveState;
	expect(next.kind === 'conflict' && next.current.kind).toBe('present');
});

test('a failed save and a store that throws both keep the buffer for a retry', async () => {
	const file = await setup();
	file.fail({ name: 'Io', message: 'disk full' });
	file.draft.inputSource(B);
	await file.draft.save();
	expect(file.draft.saveState).toEqual({
		kind: 'failed',
		message: 'disk full',
	});
	expect(file.draft.buffer).toBe(B);
	expect(file.draft.unsettled).toBe(true);

	file.fail(new Error('Epicenter did not answer'));
	await file.draft.retry();
	expect(file.draft.saveState).toEqual({
		kind: 'failed',
		message: 'Epicenter did not answer',
	});
	expect(file.draft.buffer).toBe(B);

	file.fail(undefined);
	await file.draft.retry();
	expect(file.disk).toBe(B);
	expect(file.draft.saveState.kind).toBe('saved');
	expect(file.draft.unsettled).toBe(false);
});

test('unsent thought text and refused capture text are unsettled until resolved', async () => {
	const file = await setup();
	expect(file.draft.unsettled).toBe(false);
	file.draft.newThought = 'not added yet';
	expect(file.draft.unsettled).toBe(true);
	expect(await file.draft.settle()).toBe(false);
	expect(file.draft.addThought()).toBe(true);
	expect(file.draft.newThought).toBe('');
	await file.draft.save();
	expect(file.disk).toBe(`${A}- not added yet\n`);
	expect(file.draft.unsettled).toBe(false);

	// An unclosed fence would absorb the section: the text is kept, not applied.
	file.draft.inputText('A\n```\nopen');
	expect(file.draft.textIsPending).toBe(true);
	expect(file.draft.text).toBe('A\n```\nopen');
	expect(file.draft.refusal).toContain('would not read back');
	expect(file.draft.dirty).toBe(false);
	expect(file.draft.unsettled).toBe(true);
	file.draft.inputText('A\n```\nopen\n```');
	expect(file.draft.textIsPending).toBe(false);
	expect(file.draft.document.text).toBe('A\n```\nopen\n```');
});

test('a thought edit begun before the buffer changed is refused and its text kept', async () => {
	const file = await setup();
	const [first, second] = file.draft.document.thoughts;
	if (!first || !second) throw new Error('fixture');
	file.draft.startEditing(first);
	file.draft.inputEditing('first, edited');
	// Something else changes the buffer: a different generation.
	file.draft.inputText('A changed');
	expect(file.draft.commitEditing()).toBe(false);
	expect(file.draft.editing?.text).toBe('first, edited');
	expect(file.draft.refusal).toContain('changed since this thought was shown');
	expect(file.draft.document.thoughts.map((thought) => thought.text)).toEqual([
		'first',
		'second',
	]);
	// The stale operands are refused for delete and for both sides of a swap.
	expect(file.draft.deleteThought(first)).toBe(false);
	const [nowFirst, nowSecond] = file.draft.document.thoughts;
	if (!nowFirst || !nowSecond) throw new Error('fixture');
	expect(file.draft.swapThoughts(first, nowSecond)).toBe(false);
	expect(file.draft.swapThoughts(nowFirst, second)).toBe(false);
	expect(file.draft.swapThoughts(nowFirst, nowSecond)).toBe(true);
	expect(file.draft.document.thoughts.map((thought) => thought.text)).toEqual([
		'second',
		'first',
	]);
});

test.each([
	[
		'new-thought text',
		(draft: Draft): void => {
			draft.newThought = 'typed, not added';
		},
	],
	[
		'whitespace-only new-thought text',
		(draft: Draft): void => {
			draft.newThought = '  ';
		},
	],
	[
		'a thought being edited',
		(draft: Draft) => {
			const [first] = draft.document.thoughts;
			if (!first) throw new Error('fixture');
			draft.startEditing(first);
			draft.inputEditing('edited, not saved');
		},
	],
	['refused capture text', (draft: Draft) => draft.inputText('A\n```\nopen')],
] as const)('a removed file keeps a clean draft that holds %s', async (_name, type) => {
	const file = await setup();
	type(file.draft);
	expect(file.draft.dirty).toBe(false);
	const before = {
		newThought: file.draft.newThought,
		editing: file.draft.editing?.text,
		text: file.draft.text,
	};
	file.outside(undefined);
	file.draft.observe({ kind: 'removed' });

	expect(file.draft.gone).toBe(false);
	expect(file.draft.unsettled).toBe(true);
	const state = file.draft.saveState;
	expect(state.kind === 'conflict' && state.current.kind).toBe('removed');
	expect({
		newThought: file.draft.newThought,
		editing: file.draft.editing?.text,
		text: file.draft.text,
	}).toEqual(before);
});

test('writing a removed draft back: B acknowledged, typing C kept, outside D shown', async () => {
	const file = await setup();
	file.draft.inputSource(B);
	file.outside(undefined);
	await file.draft.save();
	expect(file.draft.saveState.kind).toBe('conflict');

	const held = file.holdWrites();
	const writing = file.draft.saveMine();
	file.draft.inputSource(C);
	// The folder hints while the write is running.
	file.draft.observe({ kind: 'removed' });
	held.open();
	const outside = store_settled(file, D);
	await writing;
	await outside;

	expect(file.saved).toEqual([B]);
	expect(file.draft.baseline.source).toBe(B);
	expect(file.draft.buffer).toBe(C);
	expect(file.disk).toBe(D);
	const state = file.draft.saveState;
	expect(
		state.kind === 'conflict' &&
			state.current.kind === 'present' &&
			state.current.entry.source,
	).toBe(D);
});

test('writing back to a path that was taken meanwhile shows what is there', async () => {
	const file = await setup();
	file.draft.inputSource(B);
	file.outside(undefined);
	await file.draft.save();
	file.outside(D);
	await file.draft.saveMine();
	expect(file.disk).toBe(D);
	expect(file.draft.buffer).toBe(B);
	const state = file.draft.saveState;
	expect(
		state.kind === 'conflict' &&
			state.current.kind === 'present' &&
			state.current.entry.source,
	).toBe(D);
});
