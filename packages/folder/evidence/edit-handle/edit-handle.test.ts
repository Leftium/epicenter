/**
 * Edit handle engine tests (EXPERIMENT)
 *
 * Drives `createEditHandle` over an in-memory document whose reads,
 * publications, and replies are released by hand, so every interleaving is
 * exact. The autosave policy test uses a real timer. Publication emits its
 * change hint before the reply, as the Bun folder does. `folder-edits.test.ts` repeats
 * the publication-moment cases against a real directory folder.
 *
 * Key behaviors:
 * - subscribe delivers at once; states arrive in order with the current one last
 * - idle observations are adopted; a dirty draft keeps the file as incoming
 * - the own write read before its reply is not a change from elsewhere
 * - typing during a save stays unsaved against the receipt
 * - a read that started before a reply is dropped and repeated
 * - missing and unreadable are distinct
 * - an unconfirmed save stays unknown history; the file afterward is observed as usual
 * - saves target the displayed or reviewed baseline and never retry
 * - dispose stops observing but an admitted save still settles
 */
import { expect, test } from 'bun:test';
import { Ok, type Result } from 'wellcrafted/result';
import {
	FileError,
	TableError,
	type TableReplaceError,
} from '../../src/errors.js';
import {
	createEditHandle,
	type EditDocument,
	type Observation,
} from './edit-handle.js';
import { type AutosavePause, createAutosave } from './web/autosave.js';

type Snap = {
	readonly path: string;
	readonly sha256: string;
	readonly source: string;
};

const PATH = 'notes/doc.md';

/** A content-addressed capture: equal text, equal version, as with SHA-256. */
const snap = (source: string): Snap =>
	Object.freeze({ path: PATH, sha256: `sha:${source}`, source });

test('autosave pauses after an ordinary failure; later input and reads do not retry', async () => {
	let attempts = 0;
	const edit = createEditHandle(
		{
			path: PATH,
			interpret: () => undefined,
			read: async () => ({ kind: 'present' as const, snapshot: snap('A') }),
			watch: () => () => {},
			async save() {
				attempts += 1;
				return FileError.Io({
					path: PATH,
					operation: 'replace',
					cause: 'disk failure',
				});
			},
		},
		snap('A'),
	);
	let paused: AutosavePause | undefined;
	const autosave = createAutosave(edit, {
		delayMs: 20,
		onPauseChange: (reason) => {
			paused = reason;
		},
	});
	const failed = Promise.withResolvers<void>();
	const stop = edit.subscribe((state) => {
		if (state.lastSave?.kind === 'failed') failed.resolve();
	});
	try {
		autosave.start();
		edit.input('B');
		await failed.promise;
		expect(paused).toBe('failed');
		edit.input('C');
		await edit.refresh();
		await Bun.sleep(80);
		expect(attempts).toBe(1);
		expect(edit.get().source).toBe('C');
		expect(edit.get().baseline.source).toBe('A');
	} finally {
		autosave.stop();
		stop();
		await edit.dispose();
	}
});

function setup(initial = 'A') {
	let disk: Observation<Snap> = { kind: 'present', snapshot: snap(initial) };
	const watchers = new Set<() => void>();
	const heldReads: (() => void)[] = [];
	let holdingReads = false;
	let reads = 0;
	const saves: {
		path: string;
		source: string;
		against: string;
		publish(): void;
		reply(): void;
		loseReply(): void;
	}[] = [];

	const hint = () => {
		for (const watcher of [...watchers]) watcher();
	};

	const document: EditDocument<Snap, { length: number }> = {
		path: PATH,
		interpret: (source) => ({ length: source.length }),
		read() {
			reads += 1;
			// What the read sees is fixed when it starts.
			const seen = disk;
			if (!holdingReads) return Promise.resolve(seen);
			return new Promise((resolve) => heldReads.push(() => resolve(seen)));
		},
		save(baseline, source) {
			const reply = Promise.withResolvers<Result<Snap, TableReplaceError>>();
			let result: Result<Snap, TableReplaceError> | undefined;
			saves.push({
				path: baseline.path,
				source,
				against: baseline.sha256,
				publish() {
					const actual =
						disk.kind === 'present' ? disk.snapshot.sha256 : undefined;
					if (actual !== baseline.sha256) {
						result = FileError.Conflict({
							path: PATH,
							expectedSha256: baseline.sha256,
							actualSha256: actual,
						});
						return;
					}
					disk = { kind: 'present', snapshot: snap(source) };
					result = Ok(snap(source));
					hint();
				},
				reply() {
					if (result === undefined) throw new Error('publish before reply');
					reply.resolve(result);
				},
				loseReply() {
					reply.resolve(
						FileError.Unconfirmed({
							path: PATH,
							operation: 'replace',
							cause: 'reply lost',
						}),
					);
				},
			});
			return reply.promise;
		},
		watch(onChange) {
			watchers.add(onChange);
			return () => {
				watchers.delete(onChange);
			};
		},
	};

	return {
		edit: createEditHandle(document, snap(initial)),
		document,
		saves,
		/** Another writer saves, and the folder hints. */
		write(source: string) {
			disk = { kind: 'present', snapshot: snap(source) };
			hint();
		},
		remove() {
			disk = { kind: 'missing' };
			hint();
		},
		corrupt() {
			disk = {
				kind: 'unreadable',
				error: TableError.InvalidUtf8({ path: PATH }).error,
			};
			hint();
		},
		holdReads() {
			holdingReads = true;
		},
		releaseReads() {
			holdingReads = false;
			for (const release of heldReads.splice(0)) release();
		},
		get reads() {
			return reads;
		},
		get watching() {
			return watchers.size;
		},
	};
}

// ============================================================================
// Notification
// ============================================================================

test('subscribe delivers the current state at once, and get() is stable until a change', async () => {
	const { edit } = setup();
	await edit.refresh();
	const seen: unknown[] = [];
	const stop = edit.subscribe((state) => seen.push(state));
	expect(seen).toHaveLength(1);
	expect(seen[0]).toBe(edit.get());
	expect(edit.get()).toBe(edit.get());

	edit.input('A1');
	expect(seen).toHaveLength(2);
	expect(seen[1]).toBe(edit.get());

	stop();
	edit.input('A2');
	expect(seen).toHaveLength(2);
});

test('a listener that edits during delivery: every listener sees states in order and the current one last', () => {
	const { edit } = setup();
	const first: string[] = [];
	const second: string[] = [];
	edit.subscribe((state) => {
		first.push(state.source);
		if (state.source === 'B') edit.input('B!');
	});
	edit.subscribe((state) => second.push(state.source));

	edit.input('B');

	expect(first).toEqual(['A', 'B', 'B!']);
	expect(second).toEqual(['A', 'B', 'B!']);
	expect(edit.get().source).toBe('B!');
});

// ============================================================================
// Observation
// ============================================================================

test('a clean editor adopts the saved file; a dirty one keeps its draft and shows the file as incoming', async () => {
	const { edit, write } = setup();
	write('C');
	await edit.refresh();
	expect(edit.get()).toMatchObject({
		baseline: snap('C'),
		source: 'C',
		isDirty: false,
		incoming: undefined,
	});

	edit.input('mine');
	write('D');
	await edit.refresh();
	expect(edit.get()).toMatchObject({
		baseline: snap('C'),
		source: 'mine',
		isDirty: true,
		incoming: { kind: 'present', snapshot: snap('D') },
	});
});

test('missing and unreadable are different observations, and neither replaces the baseline', async () => {
	const { edit, remove, corrupt } = setup();
	remove();
	await edit.refresh();
	expect(edit.get().incoming).toEqual({ kind: 'missing' });
	expect(edit.get().baseline).toEqual(snap('A'));

	corrupt();
	await edit.refresh();
	const incoming = edit.get().incoming;
	expect(incoming?.kind).toBe('unreadable');
	expect(incoming?.kind === 'unreadable' && incoming.error.name).toBe(
		'InvalidUtf8',
	);
	expect(edit.get().source).toBe('A');
});

// ============================================================================
// Saving
// ============================================================================

test('the own write read before its reply is not a change from elsewhere', async () => {
	const { edit, saves } = setup();
	edit.input('B');
	const saving = edit.save();

	saves[0]?.publish();
	await edit.refresh();
	expect(edit.get().saving).toMatchObject({ source: 'B', seenOnDisk: true });
	expect(edit.get().incoming).toBeUndefined();

	saves[0]?.reply();
	expect((await saving).kind).toBe('saved');
	await edit.refresh();
	expect(edit.get()).toMatchObject({
		baseline: snap('B'),
		isDirty: false,
		incoming: undefined,
		saving: undefined,
	});
});

test('typing during a save stays unsaved against the receipt', async () => {
	const { edit, saves } = setup();
	edit.input('B');
	const saving = edit.save();
	expect(await edit.save()).toEqual({ kind: 'refused', reason: 'saving' });
	edit.input('B2');

	saves[0]?.publish();
	saves[0]?.reply();
	expect(await saving).toEqual({ kind: 'saved', receipt: snap('B') });
	expect(saves[0]?.source).toBe('B');
	expect(edit.get()).toMatchObject({
		baseline: snap('B'),
		source: 'B2',
		isDirty: true,
	});
});

test("another writer's C after B's publication is kept for review when dirty and adopted when clean", async () => {
	const dirty = setup();
	dirty.edit.input('B');
	const dirtySave = dirty.edit.save();
	dirty.edit.input('B2');
	dirty.saves[0]?.publish();
	dirty.write('C');
	dirty.saves[0]?.reply();
	await dirtySave;
	await dirty.edit.refresh();
	expect(dirty.edit.get()).toMatchObject({
		baseline: snap('B'),
		source: 'B2',
		incoming: { kind: 'present', snapshot: snap('C') },
	});

	const clean = setup();
	clean.edit.input('B');
	const cleanSave = clean.edit.save();
	clean.saves[0]?.publish();
	clean.write('C');
	clean.saves[0]?.reply();
	await cleanSave;
	await clean.edit.refresh();
	expect(clean.edit.get()).toMatchObject({
		baseline: snap('C'),
		source: 'C',
		incoming: undefined,
	});
});

test('a read that started before the reply is dropped, so the saved draft does not revert to it', async () => {
	const { edit, saves, holdReads, releaseReads } = setup();
	await edit.refresh();
	edit.input('B');
	const saving = edit.save();

	holdReads();
	void edit.refresh(); // sees A: it starts before publication
	saves[0]?.publish();
	saves[0]?.reply();
	await saving;
	const shown: string[] = [];
	edit.subscribe((state) => shown.push(state.source));
	releaseReads();
	await edit.refresh();

	// Applied, A would read as a clean editor's newer file and be adopted,
	// until a later read brought B back.
	expect(shown.every((source) => source === 'B')).toBe(true);
	expect(edit.get()).toMatchObject({
		baseline: snap('B'),
		source: 'B',
		incoming: undefined,
	});
});

test('a conflict keeps the draft and the displayed baseline, and nothing retries', async () => {
	const { edit, saves, write } = setup();
	edit.input('B');
	write('C');
	await edit.refresh();
	expect(edit.get().incoming).toEqual({
		kind: 'present',
		snapshot: snap('C'),
	});

	const saving = edit.save();
	expect(saves[0]?.against).toBe(snap('A').sha256);
	saves[0]?.publish();
	saves[0]?.reply();
	expect((await saving).kind).toBe('conflict');
	await edit.refresh();

	expect(saves).toHaveLength(1);
	expect(edit.get()).toMatchObject({
		baseline: snap('A'),
		source: 'B',
		incoming: { kind: 'present', snapshot: snap('C') },
	});
});

test('resolution uses the reviewed snapshot; a newer file stays incoming and the save conflicts again', async () => {
	const { edit, saves, write } = setup();
	edit.input('B');
	write('C');
	await edit.refresh();
	const reviewed = edit.get().incoming;
	if (reviewed?.kind !== 'present') throw new Error('expected incoming C');

	write('D');
	await edit.refresh();
	expect(edit.keepDraft(reviewed.snapshot).error).toBeNull();
	await edit.refresh();
	expect(edit.get()).toMatchObject({
		baseline: snap('C'),
		source: 'B',
		incoming: { kind: 'present', snapshot: snap('D') },
	});

	const saving = edit.save();
	expect(saves[0]?.against).toBe(snap('C').sha256);
	saves[0]?.publish();
	saves[0]?.reply();
	expect((await saving).kind).toBe('conflict');
});

test('an unconfirmed save stays unknown history, even after its text is read from the file', async () => {
	const { edit, saves, write } = setup();
	edit.input('B');
	const saving = edit.save();
	saves[0]?.loseReply();
	expect((await saving).kind).toBe('unconfirmed');

	await edit.refresh();
	expect(edit.get()).toMatchObject({
		baseline: snap('A'),
		source: 'B',
		lastSave: { kind: 'unconfirmed', attempt: { source: 'B' } },
	});

	// The draft now matches the file, as with any writer. Nothing proves
	// this request wrote it, so the outcome is not upgraded.
	write('B');
	await edit.refresh();
	expect(edit.get()).toMatchObject({
		baseline: snap('B'),
		isDirty: false,
		lastSave: { kind: 'unconfirmed' },
	});
	expect(saves).toHaveLength(1);
});

// ============================================================================
// Disposal
// ============================================================================

test('dispose stops observing and refuses edits, but an admitted save still settles into the state', async () => {
	const setupResult = setup();
	const { edit, saves } = setupResult;
	await edit.refresh();
	edit.input('B');
	const saving = edit.save();

	const disposed = edit.dispose();
	expect(setupResult.watching).toBe(0);
	expect(edit.input('C').error).toEqual({
		kind: 'refused',
		reason: 'disposed',
	});
	expect(await edit.save()).toEqual({ kind: 'refused', reason: 'disposed' });

	const seen: unknown[] = [];
	edit.subscribe((state) => seen.push(state));
	const readsBefore = setupResult.reads;
	saves[0]?.publish();
	saves[0]?.reply();

	expect((await disposed)?.kind).toBe('saved');
	expect((await saving).kind).toBe('saved');
	expect(edit.get()).toMatchObject({
		baseline: snap('B'),
		lastSave: { kind: 'saved' },
		isDisposed: true,
	});
	expect(seen.at(-1)).toBe(edit.get());
	expect(setupResult.reads).toBe(readsBefore);
});

// ============================================================================
// Wave 2: path binding, reentrant listeners, uncertain saves
// ============================================================================

test('a snapshot of another file neither opens a handle nor redirects its next save', async () => {
	const { edit, document, saves, write } = setup();
	const other = Object.freeze({
		path: 'notes/other.md',
		sha256: 'sha:X',
		source: 'X',
	});
	expect(() => createEditHandle(document, other)).toThrow(TypeError);

	edit.input('B');
	write('C');
	await edit.refresh();
	const before = edit.get();
	expect(edit.keepDraft(other).error).toEqual({
		kind: 'refused',
		reason: 'otherPath',
	});
	expect(edit.takeObserved(other).error).toEqual({
		kind: 'refused',
		reason: 'otherPath',
	});
	expect(edit.get()).toBe(before);

	void edit.save();
	expect(saves[0]).toMatchObject({ path: PATH, against: snap('A').sha256 });
});

test('a listener that disposes when the save is admitted still waits for that write', async () => {
	const { edit, saves } = setup();
	await edit.refresh();
	edit.input('B');
	let disposed: Promise<unknown> | undefined;
	edit.subscribe((state) => {
		if (state.saving !== undefined && disposed === undefined)
			disposed = edit.dispose();
	});

	const saving = edit.save();
	expect(saves).toHaveLength(1);
	saves[0]?.publish();
	saves[0]?.reply();

	expect(await disposed).toMatchObject({ kind: 'saved', receipt: snap('B') });
	expect((await saving).kind).toBe('saved');
	expect(edit.get()).toMatchObject({ isDisposed: true, baseline: snap('B') });
});

test("a listener that saves again on B's receipt keeps C admitted after B's save returns", async () => {
	const { edit, saves } = setup();
	edit.input('B');
	let second: Promise<unknown> | undefined;
	edit.subscribe((state) => {
		if (state.lastSave?.kind === 'saved' && state.isDirty && !second)
			second = edit.save();
	});
	const first = edit.save();
	edit.input('C');
	saves[0]?.publish();
	saves[0]?.reply();

	expect((await first).kind).toBe('saved');
	expect(saves).toHaveLength(2);
	expect(edit.get().saving?.source).toBe('C');

	const disposed = edit.dispose();
	saves[1]?.publish();
	saves[1]?.reply();
	expect(await disposed).toMatchObject({ kind: 'saved', receipt: snap('C') });
	expect(await second).toMatchObject({ kind: 'saved' });
});

// ============================================================================
// Wave 3: an unconfirmed save is history, and the file is observed as usual
// ============================================================================

test('discard is refused while B is admitted, allowed once B is unconfirmed; a late B is adopted with no A written back', async () => {
	const { edit, saves, write } = setup();
	edit.input('B');
	const saving = edit.save();
	expect(edit.discard().error).toEqual({ kind: 'refused', reason: 'saving' });
	saves[0]?.loseReply();
	expect((await saving).kind).toBe('unconfirmed');
	await edit.refresh();

	expect(edit.discard().error).toBeNull();
	expect(edit.get()).toMatchObject({ source: 'A', isDirty: false });

	write('B');
	await edit.refresh();
	expect(edit.get()).toMatchObject({
		baseline: snap('B'),
		source: 'B',
		isDirty: false,
		incoming: undefined,
		lastSave: { kind: 'unconfirmed' },
	});
	expect(saves).toHaveLength(1);
});

test('a late B while newer C is drafted is incoming for review; keeping C over the reviewed B saves conditionally on B', async () => {
	const { edit, saves, write } = setup();
	edit.input('B');
	const saving = edit.save();
	saves[0]?.loseReply();
	await saving;
	edit.input('C');

	write('B');
	await edit.refresh();
	const incoming = edit.get().incoming;
	expect(incoming).toEqual({ kind: 'present', snapshot: snap('B') });
	expect(edit.get()).toMatchObject({ baseline: snap('A'), source: 'C' });
	if (incoming?.kind !== 'present') throw new Error('expected incoming B');

	expect(edit.keepDraft(incoming.snapshot).error).toBeNull();
	const saved = edit.save();
	expect(saves[1]).toMatchObject({ source: 'C', against: snap('B').sha256 });
	saves[1]?.publish();
	saves[1]?.reply();
	expect(await saved).toEqual({ kind: 'saved', receipt: snap('C') });
});

test('after an unconfirmed save, a missing or unreadable file is incoming and discard still works', async () => {
	for (const lose of ['remove', 'corrupt'] as const) {
		const context = setup();
		const { edit, saves } = context;
		edit.input('B');
		const saving = edit.save();
		saves[0]?.loseReply();
		await saving;
		context[lose]();
		await edit.refresh();

		expect(edit.discard().error).toBeNull();
		await edit.refresh();
		expect(edit.get()).toMatchObject({
			source: 'A',
			incoming: { kind: lose === 'remove' ? 'missing' : 'unreadable' },
			lastSave: { kind: 'unconfirmed' },
		});
	}
});
