/**
 * Draft Tests
 *
 * Drives the real draft runes module against a store whose writes resolve
 * only when the test says so, which makes every save and refresh race a
 * fixed sequence instead of a matter of timing.
 *
 * Key behaviors:
 * - A clean draft adopts an external change and writes nothing back
 * - A dirty draft keeps its text and records the external version separately
 * - A save acknowledges only the text it captured
 * - A stale save is refused and the draft is kept
 * - A failed save keeps the draft and can be retried
 * - A removed or unreadable file leaves a dirty draft in place
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { captureVersion } from '@epicenter/app/files';
import type { Observed, SavedText } from './draft.svelte.ts';

const { createDraft } = await import('./draft.svelte.ts');

const encoder = new TextEncoder();
const PATH = 'notes/a.md';

async function saved(source: string): Promise<SavedText> {
	return {
		path: PATH,
		source,
		version: await captureVersion(encoder.encode(source)),
	};
}

/**
 * A file with one conditional writer. `hold()` makes the next write wait
 * before it checks the file, as a slow disk or an injected delay would.
 */
async function disk(initial: string) {
	let file: SavedText | undefined = await saved(initial);
	let unreadable: string | undefined;
	let gate: Promise<void> | undefined;
	let release = () => {};
	let failNext: string | undefined;
	const writes: string[] = [];
	return {
		writes,
		get source() {
			return file?.source;
		},
		hold() {
			gate = new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		release() {
			release();
			gate = undefined;
		},
		failNext(message: string) {
			failNext = message;
		},
		/** Another program replaces, removes, or corrupts the file. */
		async external(source: string | undefined) {
			file = source === undefined ? undefined : await saved(source);
		},
		corrupt(message: string) {
			unreadable = message;
		},
		observed(): Observed<SavedText> {
			if (unreadable !== undefined)
				return { kind: 'unreadable', message: unreadable };
			return file === undefined
				? { kind: 'removed' }
				: { kind: 'present', file };
		},
		store: {
			async write(accepted: SavedText, source: string) {
				await gate;
				if (failNext !== undefined) {
					const message = failNext;
					failNext = undefined;
					return { data: null, error: { name: 'Io', message } };
				}
				if (
					file === undefined ||
					file.version.sha256 !== accepted.version.sha256
				)
					return {
						data: null,
						error: {
							name: 'Conflict',
							message: 'The file changed after it was read',
						},
					};
				file = await saved(source);
				writes.push(source);
				return { data: file, error: null };
			},
			async read(): Promise<Observed<SavedText>> {
				if (unreadable !== undefined)
					return { kind: 'unreadable', message: unreadable };
				return file === undefined
					? { kind: 'removed' }
					: { kind: 'present', file };
			},
		},
	};
}

const open = async (source: string) => {
	const files = await disk(source);
	const draft = createDraft(files.store, await saved(source), {
		batchMs: null,
	});
	return { files, draft };
};

test('a clean draft adopts an external change without writing', async () => {
	const { files, draft } = await open('one\n');
	await files.external('two\n');
	expect(draft.observe(files.observed())).toBe('adopted');
	expect(draft.buffer).toBe('two\n');
	expect(draft.accepted.source).toBe('two\n');
	expect(draft.phase).toBe('saved');
	expect(draft.adoptions).toBe(1);
	await draft.save();
	expect(files.writes).toEqual([]);
});

test('observing the same bytes changes nothing and counts no adoption', async () => {
	const { files, draft } = await open('one\n');
	draft.input('one and mine\n');
	expect(draft.observe(files.observed())).toBe('same');
	expect(draft.buffer).toBe('one and mine\n');
	expect(draft.adoptions).toBe(0);
});

test('a dirty draft keeps its text and holds the external version apart', async () => {
	const { files, draft } = await open('one\n');
	draft.input('mine\n');
	await files.external('theirs\n');
	expect(draft.observe(files.observed())).toBe('conflict');
	expect(draft.buffer).toBe('mine\n');
	expect(draft.accepted.source).toBe('one\n');
	expect(draft.external).toMatchObject({
		kind: 'changed',
		current: { source: 'theirs\n' },
	});
	expect(draft.phase).toBe('conflict');
	// Autosave is paused: asking for a save writes nothing.
	await draft.save();
	expect(files.writes).toEqual([]);
	expect(files.source).toBe('theirs\n');
});

test('typing during a save stays dirty after the captured text is accepted', async () => {
	const { files, draft } = await open('one\n');
	draft.input('A\n');
	files.hold();
	const saving = draft.save();
	expect(draft.phase).toBe('saving');
	expect(draft.inFlight).toEqual({ source: 'A\n' });
	draft.input('A and B\n');
	files.release();
	await saving;
	expect(files.writes).toEqual(['A\n']);
	expect(draft.accepted.source).toBe('A\n');
	expect(draft.buffer).toBe('A and B\n');
	expect(draft.dirty).toBe(true);
	expect(draft.inFlight).toBeUndefined();
});

test('newer typing is saved by the next save, not lost', async () => {
	const { files, draft } = await open('one\n');
	draft.input('A\n');
	files.hold();
	const first = draft.save();
	draft.input('A and B\n');
	const second = draft.save();
	files.release();
	await Promise.all([first, second]);
	expect(files.writes).toEqual(['A\n', 'A and B\n']);
	expect(draft.phase).toBe('saved');
});

test('a stale save is refused and the draft is kept', async () => {
	const { files, draft } = await open('one\n');
	draft.input('mine\n');
	files.hold();
	const saving = draft.save();
	await files.external('theirs\n');
	files.release();
	await saving;
	expect(files.writes).toEqual([]);
	expect(files.source).toBe('theirs\n');
	expect(draft.buffer).toBe('mine\n');
	expect(draft.external).toMatchObject({
		kind: 'changed',
		current: { source: 'theirs\n' },
	});
	expect(draft.phase).toBe('conflict');
});

test('an observation during a save is rechecked when the save settles', async () => {
	const { files, draft } = await open('one\n');
	draft.input('mine\n');
	files.hold();
	const saving = draft.save();
	// The watcher reports the path while the save is still waiting.
	expect(draft.observe(files.observed())).toBe('deferred');
	files.release();
	await saving;
	// The save landed; the deferred check found the draft's own bytes.
	expect(files.writes).toEqual(['mine\n']);
	expect(draft.phase).toBe('saved');
	expect(draft.external).toBeUndefined();
});

test('a change that lands right after a save is caught by the deferred recheck', async () => {
	const { files, draft } = await open('one\n');
	// Another program rewrites the file just after the save's write is accepted.
	const write = files.store.write;
	files.store.write = async (accepted, source) => {
		const result = await write(accepted, source);
		await files.external('theirs\n');
		return result;
	};
	draft.input('mine\n');
	files.hold();
	const saving = draft.save();
	expect(draft.observe(files.observed())).toBe('deferred');
	draft.input('mine and more\n');
	files.release();
	await saving;
	expect(draft.accepted.source).toBe('mine\n');
	expect(draft.buffer).toBe('mine and more\n');
	expect(draft.external).toMatchObject({
		kind: 'changed',
		current: { source: 'theirs\n' },
	});
});

test('a failed save keeps the draft and can be retried', async () => {
	const { files, draft } = await open('one\n');
	draft.input('mine\n');
	files.failNext('disk full');
	await draft.save();
	expect(draft.phase).toBe('failed');
	expect(draft.failure).toBe('disk full');
	expect(draft.buffer).toBe('mine\n');
	expect(files.source).toBe('one\n');
	expect(draft.unsettled).toBe(true);
	await draft.retry();
	expect(draft.phase).toBe('saved');
	expect(files.source).toBe('mine\n');
});

test('a store that throws is a failed save, not a lost draft', async () => {
	const { files, draft } = await open('one\n');
	files.store.write = async () => {
		throw new Error('host unreachable');
	};
	draft.input('mine\n');
	await draft.save();
	expect(draft.phase).toBe('failed');
	expect(draft.failure).toBe('host unreachable');
	expect(draft.buffer).toBe('mine\n');
});

test('load saved discards the draft only when chosen', async () => {
	const { files, draft } = await open('one\n');
	draft.input('mine\n');
	await files.external('theirs\n');
	draft.observe(files.observed());
	draft.loadSaved();
	expect(draft.buffer).toBe('theirs\n');
	expect(draft.phase).toBe('saved');
	expect(draft.adoptions).toBe(1);
	expect(files.writes).toEqual([]);
});

test('save mine writes over the reviewed version', async () => {
	const { files, draft } = await open('one\n');
	draft.input('mine\n');
	await files.external('theirs\n');
	draft.observe(files.observed());
	await draft.saveMine();
	expect(files.source).toBe('mine\n');
	expect(draft.phase).toBe('saved');
});

test('save mine is refused again when the file changed after the review', async () => {
	const { files, draft } = await open('one\n');
	draft.input('mine\n');
	await files.external('theirs\n');
	draft.observe(files.observed());
	await files.external('theirs again\n');
	await draft.saveMine();
	expect(files.source).toBe('theirs again\n');
	expect(draft.buffer).toBe('mine\n');
	expect(draft.external).toMatchObject({
		kind: 'changed',
		current: { source: 'theirs again\n' },
	});
});

test('a conflict ends when the file returns to what the draft agreed with', async () => {
	const { files, draft } = await open('one\n');
	draft.input('mine\n');
	await files.external('theirs\n');
	draft.observe(files.observed());
	await files.external('one\n');
	expect(draft.observe(files.observed())).toBe('same');
	expect(draft.external).toBeUndefined();
	expect(draft.phase).toBe('dirty');
});

test('a removed file leaves a dirty draft for recovery', async () => {
	const { files, draft } = await open('one\n');
	draft.input('mine\n');
	await files.external(undefined);
	expect(draft.observe(files.observed())).toBe('conflict');
	expect(draft.external).toEqual({ kind: 'removed' });
	expect(draft.buffer).toBe('mine\n');
	// The owner writes the draft somewhere and the draft continues from there.
	draft.rebase(await saved('mine\n'));
	expect(draft.phase).toBe('saved');
});

test('a removed file with a clean draft is simply gone', async () => {
	const { files, draft } = await open('one\n');
	await files.external(undefined);
	expect(draft.observe(files.observed())).toBe('gone');
	expect(draft.external).toBeUndefined();
});

test('a file removed during a save is reported, and the draft is kept', async () => {
	const { files, draft } = await open('one\n');
	draft.input('mine\n');
	files.hold();
	const saving = draft.save();
	await files.external(undefined);
	files.release();
	await saving;
	expect(draft.external).toEqual({ kind: 'removed' });
	expect(draft.buffer).toBe('mine\n');
});

test('an unreadable file keeps the draft', async () => {
	const { files, draft } = await open('one\n');
	draft.input('mine\n');
	files.corrupt('not valid UTF-8 text');
	expect(draft.observe(files.observed())).toBe('conflict');
	expect(draft.external).toEqual({
		kind: 'unreadable',
		message: 'not valid UTF-8 text',
	});
	expect(draft.buffer).toBe('mine\n');
	expect(draft.unsettled).toBe(true);
});

test('settle reports whether closing would lose anything', async () => {
	const { draft } = await open('one\n');
	expect(draft.unsettled).toBe(false);
	draft.input('mine\n');
	expect(draft.unsettled).toBe(true);
	expect(await draft.settle()).toBe(true);
	expect(draft.unsettled).toBe(false);
});
