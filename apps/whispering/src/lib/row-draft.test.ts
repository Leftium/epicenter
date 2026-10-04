/**
 * Row Draft Tests
 *
 * The app's save policy over one folder row editor: when typing is saved on
 * its own, and when it waits for the person. The editor here is a scripted
 * stand-in that keeps the folder editor's rules (see "Editing a row" in the
 * folder README): a save overwrites the whole document, a clean editor follows
 * a valid read, dirty input is never reset, and a lost reply stays unknown
 * after a read finds its bytes. The stand-in lets a reply be held, lost, or
 * refused at an exact moment. `library.test.ts` drives the real `table.edit`
 * over a directory, and `workspace/desktop.test.ts` drives it over the
 * desktop adapter with a save reply the shell never sent.
 *
 * Key behaviors:
 * - typing saves after a pause, and typing during a save is saved after it
 * - a failed or unconfirmed save stops saving on its own until the person
 *   saves again; a read that finds the same text clears the typing, not the
 *   unknown outcome
 * - nothing is saved on its own over another version, a removed file, a file
 *   that no longer reads as a row, or typing with issues
 * - the read that predates the save's own receipt is not another writer
 * - a clean draft whose file stops reading as a row is offered back
 * - typing is refused while new work is not admitted, and disposal waits for
 *   a save already sent
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import {
	FileError,
	type RowEditor,
	RowEditorError,
	type RowEditorState,
	type RowObservation,
	type RowRevision,
	type RowSaveOutcome,
} from '@epicenter/folder/bun';
import { Err, Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { Autosave } from './editor.svelte.js';

const { createRowDraft } = await import('./row-draft.svelte.ts');
const { TYPING_BATCH_MS } = await import('./editor.svelte.ts');

type Fields = { title: string };
type Document = RowEditorState<Fields>['document'];

const PATH = 'notes/one.md';

const canonicalOf = (document: Document) =>
	`---\n"title": ${JSON.stringify(document.fields.title)}\n---\n${document.body}`;
/** Equal content, equal hash: enough for these rules. */
const revisionOf = (document: Document): RowRevision => ({
	path: PATH,
	sha256: `sha:${canonicalOf(document)}`,
	source: canonicalOf(document),
	document,
	canonical: canonicalOf(document),
});
const readingOf = (document: Document): RowEditorState<Fields>['reading'] => {
	const { title } = document.fields;
	const valid = typeof title === 'string' && title !== '';
	return {
		fields: valid ? { title } : {},
		body: document.body,
		parseError: undefined,
		issues: valid
			? []
			: [{ field: 'title', message: 'title must not be empty' }],
	};
};
const doc = (title: string, body = ''): Document => ({
	fields: { title },
	body,
});

/**
 * The folder's file and the replies its saves get, as the test decides them.
 * `file` undefined is a removed file; `unrecognized` is text that no longer
 * reads as a row.
 */
type Script = {
	file: Document | undefined | 'unrecognized';
	replies: ('saved' | 'unconfirmed' | 'failed')[];
	/** Held until the test resolves it: a save that is out. */
	hold: Promise<void> | undefined;
	/** Held until the test resolves it: the read every save is followed by. */
	reread: Promise<void> | undefined;
	saves: Document[];
};

function scriptedEditor(initial: Document) {
	const script: Script = {
		file: initial,
		replies: [],
		hold: undefined,
		reread: undefined,
		saves: [],
	};
	const first = revisionOf(initial);
	let state: RowEditorState<Fields> = {
		path: PATH,
		baseline: first,
		document: initial,
		source: first.canonical,
		reading: readingOf(initial),
		isDirty: false,
		observation: { kind: 'present', revision: first },
		saving: undefined,
		lastSave: undefined,
		isDisposed: false,
	};
	const listeners = new Set<(state: RowEditorState<Fields>) => void>();
	const update = (patch: Partial<RowEditorState<Fields>>) => {
		state = { ...state, ...patch };
		for (const listener of [...listeners]) listener(state);
	};
	const observe = (): RowObservation<Fields> => {
		const { file } = script;
		if (file === undefined) return { kind: 'missing' };
		if (file === 'unrecognized')
			return {
				kind: 'unsupported',
				file: { path: PATH, sha256: 'sha:unrecognized', source: '!tagged' },
				refusal: { reason: 'The tag !tagged is not supported', path: [] },
			};
		return { kind: 'present', revision: revisionOf(file) };
	};
	async function refresh() {
		const observation = observe();
		if (state.saving !== undefined || observation.kind !== 'present') {
			update({ observation });
			return;
		}
		const { revision } = observation;
		if (
			revision.sha256 !== state.baseline.sha256 &&
			(!state.isDirty || revision.canonical === state.source)
		)
			update({
				baseline: revision,
				document: revision.document,
				source: revision.canonical,
				reading: readingOf(revision.document),
				isDirty: false,
				observation,
			});
		else update({ observation });
	}
	let admitted: Promise<unknown> | undefined;
	const editor: RowEditor<Fields> = {
		get: () => state,
		subscribe(listener) {
			listeners.add(listener);
			listener(state);
			return () => listeners.delete(listener);
		},
		change(requested) {
			if (state.isDisposed) return RowEditorError.Disposed({ path: PATH });
			const document = {
				fields: { ...state.document.fields, ...requested.fields },
				body: requested.body ?? state.document.body,
			} as Document;
			const source = canonicalOf(document);
			update({
				document,
				source,
				reading: readingOf(document),
				isDirty: source !== state.baseline.canonical,
			});
			return Ok(undefined);
		},
		async save() {
			if (state.isDisposed) return RowEditorError.Disposed({ path: PATH });
			if (admitted !== undefined) return RowEditorError.Saving({ path: PATH });
			if (state.reading.issues.length > 0)
				return RowEditorError.InvalidDocument({
					path: PATH,
					reading: state.reading,
				});
			const attempt = {
				path: PATH,
				document: state.document,
				source: state.source,
			};
			update({ saving: attempt });
			const run = (async () => {
				await script.hold;
				const reply = script.replies.shift() ?? 'saved';
				script.saves.push(attempt.document);
				if (reply !== 'failed') script.file = attempt.document;
				let outcome: RowSaveOutcome;
				if (reply === 'saved') {
					const receipt = revisionOf(attempt.document);
					outcome = { kind: 'saved', receipt };
					update({
						baseline: receipt,
						isDirty: state.source !== receipt.canonical,
						saving: undefined,
						lastSave: outcome,
					});
				} else {
					const { error } =
						reply === 'unconfirmed'
							? FileError.Unconfirmed({
									path: PATH,
									operation: 'overwrite',
									cause: 'reply lost',
								})
							: FileError.Io({
									path: PATH,
									operation: 'overwrite',
									cause: 'disk full',
								});
					outcome = { kind: reply, attempt, error };
					update({ saving: undefined, lastSave: outcome });
				}
				admitted = undefined;
				if (script.reread === undefined) void refresh();
				else void script.reread.then(refresh);
				return outcome.kind === 'saved'
					? Ok(outcome.receipt)
					: Err(outcome.error);
			})();
			admitted = run;
			return run;
		},
		refresh,
		adopt(reviewed) {
			const latest = state.observation;
			if (
				latest.kind !== 'present' ||
				latest.revision.canonical !== reviewed.canonical
			)
				return RowEditorError.Stale({ path: PATH, latest });
			update({
				baseline: latest.revision,
				document: latest.revision.document,
				source: latest.revision.canonical,
				reading: readingOf(latest.revision.document),
				isDirty: false,
			});
			return Ok(undefined);
		},
		async dispose() {
			update({ isDisposed: true });
			await admitted;
		},
	} as RowEditor<Fields>;
	return { editor, script };
}

function setup({
	initial = doc('One'),
	autosave = { paused: false },
}: {
	initial?: Document;
	autosave?: Autosave;
} = {}) {
	const { editor, script } = scriptedEditor(initial);
	const policy = { admitting: true, saved: 0, unfollowable: 0 };
	const copies: { path: string; content: string }[] = [];
	const draft = createRowDraft(editor, {
		files: {
			async create(path, content) {
				copies.push({ path, content: String(content) });
				return Ok({ path, sha256: 'copy' });
			},
		},
		autosave,
		admits: () => policy.admitting,
		onSaved: () => {
			policy.saved += 1;
		},
		onIdleUnfollowable: () => {
			policy.unfollowable += 1;
		},
	});
	return { draft, editor, script, policy, copies };
}

const pause = () => Bun.sleep(TYPING_BATCH_MS + 100);

// ============================================================================
// Saving on its own
// ============================================================================

test('typing saves after a pause, and typing during a save is saved after it', async () => {
	const { draft, script } = setup();
	const held = Promise.withResolvers<void>();
	script.hold = held.promise;

	expect(draft.change({ fields: { title: 'Two' } })).toBe(true);
	expect(draft.status.kind).toBe('unsaved');
	await pause();
	expect(draft.status.kind).toBe('saving');
	// Typed while the save is out: kept, and not part of what was sent.
	draft.change({ fields: { title: 'Three' } });
	script.hold = undefined;
	held.resolve();
	await pause();
	await draft.settle();

	expect(script.saves.map((saved) => saved.fields.title)).toEqual([
		'Two',
		'Three',
	]);
	expect(draft.isDirty).toBe(false);
	expect(draft.status).toEqual({ kind: 'saved' });
});

test('typing with issues is not saved and says why', async () => {
	const { draft, script } = setup();

	draft.change({ fields: { title: '' } });
	await pause();

	expect(script.saves).toEqual([]);
	expect(draft.status).toEqual({
		kind: 'invalid',
		message: 'title must not be empty',
	});
	expect(await draft.settle()).toBe(false);
	expect(script.saves).toEqual([]);
});

// ============================================================================
// A save that did not succeed
// ============================================================================

test('a failed save stops saving on its own until the person saves again', async () => {
	const { draft, script, policy } = setup();
	script.replies.push('failed');

	draft.change({ fields: { title: 'Two' } });
	expect(await draft.settle()).toBe(false);
	expect(draft.status).toMatchObject({ kind: 'failed', inFile: false });

	// More typing is held: nothing is sent on its own after a failure.
	draft.change({ fields: { title: 'Three' } });
	await pause();
	expect(await draft.settle()).toBe(false);
	expect(script.saves).toHaveLength(1);
	expect(policy.saved).toBe(0);

	await draft.saveNow();
	expect(script.saves.map((saved) => saved.fields.title)).toEqual([
		'Two',
		'Three',
	]);
	expect(draft.status).toEqual({ kind: 'saved' });
	expect(policy.saved).toBe(1);
	// Saving on its own resumes once the person's save succeeded.
	draft.change({ fields: { title: 'Four' } });
	await pause();
	expect(script.saves).toHaveLength(3);
});

test('an unconfirmed save stays unknown when the file is found holding its text, and typing after it waits for the person', async () => {
	const { draft, script } = setup();
	script.replies.push('unconfirmed');

	draft.change({ fields: { title: 'Two' } });
	await draft.settle();
	// The reread that follows every save finds the bytes that were sent.
	await draft.refresh();

	expect(draft.isDirty).toBe(false);
	expect(draft.state.lastSave?.kind).toBe('unconfirmed');
	// The file holds the text; the save that may have put it there is still
	// unknown, and the draft holds until the person chooses.
	expect(draft.status).toMatchObject({ kind: 'unconfirmed', inFile: true });
	expect(draft.holds).toBe(true);
	expect(await draft.settle()).toBe(false);

	draft.change({ fields: { title: 'Three' } });
	await pause();
	expect(script.saves).toHaveLength(1);
	expect(draft.status).toMatchObject({ kind: 'unconfirmed', inFile: false });

	await draft.saveNow();
	expect(script.saves).toHaveLength(2);
	expect(draft.status).toEqual({ kind: 'saved' });
	expect(draft.holds).toBe(false);
});

test('taking the file as it is releases a clean draft after an unknown save, and the last save stays unknown', async () => {
	const { draft, script } = setup();
	script.replies.push('unconfirmed');
	draft.change({ fields: { title: 'Two' } });
	await draft.settle();
	await draft.refresh();
	expect(draft.holds).toBe(true);

	expectOk(draft.takeCurrent());

	expect(draft.holds).toBe(false);
	expect(draft.status).toEqual({ kind: 'saved' });
	expect(draft.state.lastSave?.kind).toBe('unconfirmed');
	expect(draft.unknown).toContain('reply lost');
	expect(await draft.settle()).toBe(true);
	// Saving goes on by itself again.
	draft.change({ fields: { title: 'Three' } });
	await pause();
	expect(script.saves).toHaveLength(2);
});

test('nothing is written while writes are held, and holding typing for later is kept', async () => {
	const { editor, script } = scriptedEditor(doc('One'));
	let writes = false;
	const draft = createRowDraft(editor, {
		files: { create: async (path) => Ok({ path, sha256: 'copy' }) },
		autosave: { paused: false },
		admits: () => true,
		writes: () => writes,
		onSaved: () => {},
		onIdleUnfollowable: () => {},
	});

	expect(draft.change({ fields: { title: 'Two' } })).toBe(true);
	await pause();
	await draft.saveNow();
	expect(await draft.settle()).toBe(false);
	expect(script.saves).toEqual([]);
	expect(draft.state.document).toEqual(doc('Two'));

	writes = true;
	draft.resume();
	await pause();
	expect(script.saves).toEqual([doc('Two')]);
});

// ============================================================================
// The file is not what the typing was made on
// ============================================================================

test('another version under unsaved typing is never saved over on its own; taking it drops the typing', async () => {
	const { draft, script } = setup();
	draft.change({ fields: { title: 'Mine' } });
	script.file = doc('Theirs');
	await draft.refresh();
	await pause();

	expect(script.saves).toEqual([]);
	expect(draft.review).toMatchObject({
		kind: 'changed',
		current: { document: doc('Theirs') },
	});
	expect(draft.holds).toBe(true);
	expect(await draft.settle()).toBe(false);

	expectOk(draft.takeCurrent());
	expect(draft.isDirty).toBe(false);
	expect(draft.state.document).toEqual(doc('Theirs'));
	expect(script.saves).toEqual([]);
});

test('saving mine over another version is the person’s choice, and writes the whole draft', async () => {
	const { draft, script } = setup();
	draft.change({ fields: { title: 'Mine' } });
	script.file = doc('Theirs');
	await draft.refresh();

	await draft.saveNow();

	expect(script.saves).toEqual([doc('Mine')]);
	expect(draft.status).toEqual({ kind: 'saved' });
});

test('keeping a copy writes the draft beside the row and leaves the draft as it is', async () => {
	const { draft, script, copies } = setup();
	draft.change({ fields: { title: 'Mine' } });
	script.file = doc('Theirs');
	await draft.refresh();

	const copy = expectOk(await draft.keepCopy());

	expect(copy).toMatch(/^conflicts\/one-\d{8}-\d{6}\.md$/);
	expect(copies).toEqual([{ path: copy, content: canonicalOf(doc('Mine')) }]);
	expect(draft.isDirty).toBe(true);
	expect(script.saves).toEqual([]);
});

for (const [name, file] of [
	['removed', undefined],
	['unrecognized', 'unrecognized'],
] as const)
	test(`a file that is ${name} under unsaved typing is not written again on its own`, async () => {
		const { draft, script, policy } = setup();
		draft.change({ fields: { title: 'Mine' } });
		script.file = file;
		await draft.refresh();
		await pause();

		expect(draft.status.kind).toBe(name);
		expect(script.saves).toEqual([]);
		expect(script.file).toBe(file);
		// The typing is the person's: nothing offers the draft back to be dropped.
		expect(policy.unfollowable).toBe(0);
	});

test('a clean draft whose file is gone or no longer reads as a row is offered back once', async () => {
	const { draft, script, policy } = setup();
	script.file = 'unrecognized';
	await draft.refresh();
	await draft.refresh();
	await Promise.resolve();

	expect(draft.status).toEqual({ kind: 'saved' });
	expect(policy.unfollowable).toBe(1);
});

test('the read from before the save’s own receipt is not another writer', async () => {
	const { draft, script } = setup();
	const held = Promise.withResolvers<void>();
	// The reread after the save is held, so the editor still shows the read
	// from before it when the receipt arrives.
	script.reread = held.promise;

	draft.change({ fields: { title: 'Two' } });
	const saving = draft.saveNow();
	// Typed while the save is out, so the draft is dirty against its receipt.
	draft.change({ fields: { title: 'Three' } });
	await saving;

	expect(draft.isDirty).toBe(true);
	expect(draft.state.observation).toMatchObject({
		kind: 'present',
		revision: { document: doc('One') },
	});
	expect(draft.review).toBeUndefined();
	expect(draft.status.kind).toBe('unsaved');
	held.resolve();
});

// ============================================================================
// Admission and disposal
// ============================================================================

test('typing and choices are refused while new work is not admitted', async () => {
	const { draft, script, policy } = setup();
	policy.admitting = false;

	expect(draft.change({ fields: { title: 'Two' } })).toBe(false);
	await draft.saveNow();
	expect(draft.isDirty).toBe(false);
	expect(script.saves).toEqual([]);
	const { error: takeRefusal } = draft.takeCurrent();
	expect(takeRefusal).toContain('closing');
	const { error: copyRefusal } = await draft.keepCopy();
	expect(copyRefusal).toContain('closing');
});

test('settling saves what can be saved even while autosave is paused', async () => {
	const autosave = { paused: true };
	const { draft, script } = setup({ autosave });

	draft.change({ fields: { title: 'Two' } });
	await pause();
	expect(script.saves).toEqual([]);
	expect(draft.status.kind).toBe('unsaved');

	expect(await draft.settle()).toBe(true);
	expect(script.saves).toEqual([doc('Two')]);
});

test('disposal waits for a save already sent, and nothing new is admitted after it', async () => {
	const { draft, script } = setup();
	const held = Promise.withResolvers<void>();
	script.hold = held.promise;
	draft.change({ fields: { title: 'Two' } });
	const saving = draft.saveNow();

	let disposed = false;
	const disposal = draft.dispose().then(() => {
		disposed = true;
	});
	await Promise.resolve();
	expect(disposed).toBe(false);

	held.resolve();
	await saving;
	await disposal;
	expect(script.saves).toEqual([doc('Two')]);
	expect(draft.state.lastSave?.kind).toBe('saved');
	expect(draft.change({ fields: { title: 'Three' } })).toBe(false);
});
