/**
 * Session Lifetime Tests
 *
 * The app layout opens one session and every page works inside it. These drive
 * the real session over a real folder to establish what a page change may and
 * may not do. There is no window or router here: a page change is modelled as
 * what the shell asks the session (`blocksNavigation`), and what the session
 * holds is read before and after. That the layout is the only opener is
 * checked from the sources in `page-boundary.test.ts`.
 *
 * Key behaviors:
 * - Opening a session opens the folder once; closing it releases it once
 * - A navigation between pages is never held back, whatever is in progress,
 *   and leaves every held thing as it was
 * - A navigation that unloads the document is held back only while something
 *   exists only in the window
 * - The close guard belongs to the session and stops listening when it closes
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { OpenFolderError } from '@epicenter/folder/bun';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { toneWav } from './capture.js';
import { STARTER_TRANSFORMATIONS } from './definition.js';
import type { Session } from './session.svelte.js';
import { type Workspace, WorkspaceError } from './workspace/types.js';
import {
	deferred,
	openTestWorkspace,
	type TestWorkspaceOptions,
} from './workspace.test-support.js';

const { mountSession, openSession } = await import('./session.svelte.ts');
const { patchRow } = await import('./editor.svelte.ts');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(options: TestWorkspaceOptions = {}) {
	const test = await openTestWorkspace(options);
	const session: Session = expectOk(await openSession(test.open));
	cleanups.push(async () => {
		await session.close();
		await test.remove();
	});
	return { session, library: session.library, test };
}

/** Moving between `/`, `/recordings`, and `/transformations`. */
const INTERNAL = { willUnload: false };
/** Closing the tab, reloading, or following a link out of the app. */
const UNLOAD = { willUnload: true };

test('a session opens the folder once and releases it once', async () => {
	const { session, library, test } = await open();
	expect(test.opens).toBe(1);
	expect(test.closeListeners.size).toBe(1);
	// The first read happened: settings exist from the first launch on.
	expect(library.settings.transcriptionModel).toBe('verification-model');

	await session.close();
	await session.close();

	expect(test.opens).toBe(1);
	expect(test.closes).toBe(1);
	expect(test.closeListeners.size).toBe(0);
});

test('with nothing held, neither a page change nor leaving is held back', async () => {
	const { session } = await open();

	expect(session.blocksNavigation(INTERNAL)).toBe(false);
	expect(session.blocksNavigation(UNLOAD)).toBe(false);
});

test('a live recording survives a page change and can still be stopped and saved', async () => {
	const { session, library } = await open();
	await library.startRecording();
	const before = library.recorder;
	expect(before.phase).toBe('recording');

	expect(session.blocksNavigation(INTERNAL)).toBe(false);

	expect(library.recorder).toBe(before);
	expect(session.blocksNavigation(UNLOAD)).toBe(true);
	await library.stopRecording();
	expect(library.entries).toHaveLength(1);
	expect(session.blocksNavigation(UNLOAD)).toBe(false);
});

test('a page change keeps the selection, a dirty edit, a running transcription, and the terminal', async () => {
	const transcript = deferred<Awaited<ReturnType<Workspace['transcribe']>>>();
	const { session, library, test } = await open({
		transcribe: () => transcript.promise,
	});
	const { view } = session;
	await library.startRecording();
	await library.stopRecording();
	const recording = library.entries[0]!;
	const selection = library.selection;
	if (selection?.kind !== 'recording') throw new Error('expected a recording');

	// A transcript request in flight.
	const transcribing = library.transcribe(recording);
	expect(library.transcriptionRun(recording.stem!)?.kind).toBe('running');
	// Typing that is not saved.
	library.autosave.paused = true;
	patchRow(selection.editor, { fields: { title: 'Typed, not saved' } });
	// A transformation draft that is not saved.
	await library.createTransformation(STARTER_TRANSFORMATIONS[0]!);
	const draft = library.selectedTransformation!.editor;
	patchRow(draft, { body: 'A prompt in progress\n' });
	// A terminal with output, history, a directory, and a half-typed command.
	library.terminal.command = 'cd recordings';
	await library.terminal.run();
	library.terminal.command = 'git status';
	await library.terminal.run();
	library.terminal.command = 'git lo';
	// What the shell shows.
	view.terminalOpen = true;
	view.filesPane = true;
	view.recordingQuery = 'typed';

	for (let visit = 0; visit < 3; visit++)
		expect(session.blocksNavigation(INTERNAL)).toBe(false);

	expect(library.selectedPath).toBe(recording.path);
	// The same editor object, so the draft in it is the one that was typed into.
	const kept = library.selection;
	expect(kept?.kind === 'recording' && kept.editor).toBe(selection.editor);
	expect(selection.editor.buffer).toContain('title: Typed, not saved');
	expect(selection.editor.dirty).toBe(true);
	expect(library.transcriptionRun(recording.stem!)?.kind).toBe('running');
	expect(library.selectedTransformation?.editor).toBe(draft);
	expect(draft.buffer).toContain('A prompt in progress');
	expect(draft.dirty).toBe(true);
	expect(test.terminalRuns).toEqual(['cd recordings', 'git status']);
	expect(library.terminal.runs.map((run) => run.command)).toEqual([
		'cd recordings',
		'git status',
	]);
	expect(library.terminal.runs[1]!.result?.stdout).toBe('ran git status\n');
	expect(library.terminal.cwd).toBe('/recordings');
	expect(library.terminal.command).toBe('git lo');
	expect(library.terminal.recall('previous')).toBe(true);
	expect(library.terminal.command).toBe('git status');
	expect(view).toMatchObject({
		terminalOpen: true,
		filesPane: true,
		recordingQuery: 'typed',
	});
	// The same work that a page change keeps is what leaving would lose.
	expect(session.blocksNavigation(UNLOAD)).toBe(true);
	expect(library.unsavedWork).toEqual([
		'A transcription is still running; its result would be lost.',
		`${selection.editor.path} has unsaved edits.`,
		`${draft.path} has unsaved edits.`,
	]);

	// The request that was running across those page changes still lands.
	transcript.resolve(Ok({ text: 'arrived after navigating' }));
	await transcribing;
	expect(library.resultsFor(recording.stem!)[0]!.body).toBe(
		'arrived after navigating\n',
	);
});

test('a capture that is not in the folder survives a page change with its audio and id', async () => {
	// The save is refused once, so the capture stays pending in the window.
	const { session, library } = await open({ failAudioWrites: 1 });
	await library.startRecording();
	await library.stopRecording();
	expect(library.pending).toHaveLength(1);
	const pending = library.pending[0]!;

	expect(session.blocksNavigation(INTERNAL)).toBe(false);

	expect(library.pending[0]!.capture.id).toBe(pending.capture.id);
	expect(library.pending[0]!.capture.bytes).toEqual(toneWav());
	expect(session.blocksNavigation(UNLOAD)).toBe(true);
	await library.retryPending(pending.capture.id);
	expect(library.pending).toHaveLength(0);
	expect(library.entries[0]!.stem).toBe(pending.capture.id);
	expect(session.blocksNavigation(UNLOAD)).toBe(false);
});

test('a session whose first read fails releases the folder it opened', async () => {
	const test = await openTestWorkspace();
	cleanups.push(test.remove);
	const { folder } = test.workspace;
	const unreadable: Workspace = {
		...test.workspace,
		folder: {
			...folder,
			kv: {
				...folder.kv,
				get: () => Promise.reject(new Error('the folder host went away')),
			},
		},
	};

	await expect(openSession(async () => Ok(unreadable))).rejects.toThrow(
		'the folder host went away',
	);

	expect(test.closes).toBe(1);
	expect(test.closeListeners.size).toBe(0);
});

test('a workspace that cannot be opened is returned as the refusal, and no session exists', async () => {
	let opens = 0;
	const refused = expectErr(
		await openSession(async () => {
			opens += 1;
			return WorkspaceError.BrowserFolder({
				refusal: OpenFolderError.InsideTauri().error,
			});
		}),
	);

	// One attempt, one answer: nothing else was opened in its place.
	expect(opens).toBe(1);
	expect(refused.name).toBe('BrowserFolder');
	expect(refused.message).toContain('Browser storage is not used');
});

// ============================================================================
// What the layout holds, and who answers a close
// ============================================================================

/** Counts when answering for a failed opening starts and stops. */
function closeAnswerer() {
	const counts = { started: 0, stopped: 0 };
	return {
		counts,
		answerClose: () => {
			counts.started += 1;
			return () => {
				counts.stopped += 1;
			};
		},
	};
}

const refusal = () =>
	WorkspaceError.DesktopFolder({
		refusal: OpenFolderError.WindowNotPermitted({
			scope: 'so.epicenter.whispering',
			window: 'main',
		}).error,
	});

test('while a session exists, only its guard answers a close: nothing answers for it unseen', async () => {
	const test = await openTestWorkspace({ failAudioWrites: 1 });
	const { counts, answerClose } = closeAnswerer();
	const mounted = mountSession(test.open, answerClose);
	const session = expectOk(await mounted.opening);
	cleanups.push(test.remove);
	// Something held only in the window.
	await session.library.startRecording();
	await session.library.stopRecording();
	expect(session.library.pending).toHaveLength(1);

	// The shell asks. The session's own guard is the listener, and it does not approve.
	expect(test.closeListeners.size).toBe(1);
	for (const listener of test.closeListeners) listener();
	await Bun.sleep(50);
	expect(test.answers).toEqual(['asking']);
	expect(session.leave.asking).toBe(true);
	expect(counts).toEqual({ started: 0, stopped: 0 });

	mounted.release();
	mounted.release();
	await session.close();
	expect(test.closes).toBe(1);
	expect(test.closeListeners.size).toBe(0);
	expect(counts).toEqual({ started: 0, stopped: 0 });
});

test('a refused opening starts answering closes only once it has settled, and release stops it', async () => {
	const settle = deferred<ReturnType<typeof refusal>>();
	const { counts, answerClose } = closeAnswerer();

	const mounted = mountSession(() => settle.promise, answerClose);
	// Still opening: a close asked now is not answered by anyone yet.
	await Bun.sleep(10);
	expect(counts).toEqual({ started: 0, stopped: 0 });

	settle.resolve(refusal());
	expect(expectErr(await mounted.opening).name).toBe('DesktopFolder');
	await Bun.sleep(0);
	expect(counts).toEqual({ started: 1, stopped: 0 });

	mounted.release();
	mounted.release();
	expect(counts).toEqual({ started: 1, stopped: 1 });
});

test('an opening that fails after its folder opened is also a failed opening: the folder is released, then closes are answered', async () => {
	const test = await openTestWorkspace();
	cleanups.push(test.remove);
	const { folder } = test.workspace;
	const unreadable: Workspace = {
		...test.workspace,
		folder: {
			...folder,
			kv: {
				...folder.kv,
				get: () => Promise.reject(new Error('the first read failed')),
			},
		},
	};
	const { counts, answerClose } = closeAnswerer();

	const mounted = mountSession(async () => Ok(unreadable), answerClose);
	await expect(mounted.opening).rejects.toThrow('the first read failed');
	await Bun.sleep(0);

	// No session and no guard is left listening, so nothing else would answer.
	expect(test.closes).toBe(1);
	expect(test.closeListeners.size).toBe(0);
	expect(counts).toEqual({ started: 1, stopped: 0 });
	mounted.release();
	expect(counts).toEqual({ started: 1, stopped: 1 });
});

test('a layout that went away before its opening failed never starts answering', async () => {
	const settle = deferred<ReturnType<typeof refusal>>();
	const { counts, answerClose } = closeAnswerer();
	const mounted = mountSession(() => settle.promise, answerClose);

	mounted.release();
	settle.resolve(refusal());
	await mounted.opening;
	await Bun.sleep(0);

	expect(counts).toEqual({ started: 0, stopped: 0 });
});

// ============================================================================
// A close asked while the session is still starting
// ============================================================================

/**
 * A workspace whose first read, or first settings write, is held open by the
 * test. The folder underneath is the real one, on a fresh directory, so
 * starting a session over it reads `kv.json` and then writes it.
 */
async function starting(hold: 'read' | 'write') {
	const test = await openTestWorkspace();
	cleanups.push(test.remove);
	const { folder } = test.workspace;
	const gate = deferred<void>();
	let begun = false;
	let fail: Error | undefined;
	const held = async () => {
		begun = true;
		await gate.promise;
		if (fail !== undefined) throw fail;
	};
	const workspace: Workspace = {
		...test.workspace,
		folder: {
			...folder,
			kv: {
				...folder.kv,
				get: async () => {
					if (hold === 'read') await held();
					return folder.kv.get();
				},
				update: async (...args: Parameters<typeof folder.kv.update>) => {
					if (hold === 'write') await held();
					return folder.kv.update(...args);
				},
			},
		},
	};
	return {
		test,
		open: async () => Ok(workspace),
		/** Wait until the held call has been made and is pending. */
		async begun() {
			for (let waited = 0; waited < 200 && !begun; waited++) await Bun.sleep(5);
			expect(begun).toBe(true);
		},
		finish: () => gate.resolve(),
		failWith(error: Error) {
			fail = error;
			gate.resolve();
		},
	};
}

/** Wait for something another task does. */
async function until(condition: () => boolean, what: string) {
	for (let waited = 0; waited < 300; waited++) {
		if (condition()) return;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${what}`);
}

for (const hold of ['read', 'write'] as const)
	test(`a close asked while the first ${hold} is pending is not answered until the session has started, and then its guard decides`, async () => {
		const { test, open, begun, finish } = await starting(hold);
		const { counts, answerClose } = closeAnswerer();
		const mounted = mountSession(open, answerClose);
		await begun();

		// The person asks to close, more than once, while the session is starting.
		test.requestClose();
		test.requestClose();
		await Bun.sleep(60);

		// Nobody is listening yet and nobody has answered: not even `asking`.
		expect(test.closeListeners.size).toBe(0);
		expect(test.answers).toEqual([]);
		expect(counts).toEqual({ started: 0, stopped: 0 });
		if (hold === 'write')
			// The write the session admitted has not landed; closing now would cut it.
			expect(await Bun.file(`${test.root}/kv.json`).exists()).toBe(false);

		finish();
		const session = expectOk(await mounted.opening);
		cleanups.push(() => session.close());

		// The kept request reached the session's guard once it existed. The
		// session has started and holds nothing, so the guard lets it close.
		await until(() => test.answers.length === 2, 'the guard to answer');
		expect(test.answers).toEqual(['asking', 'proceed']);
		expect(test.closeListeners.size).toBe(1);
		expect(await Bun.file(`${test.root}/kv.json`).exists()).toBe(true);
		expect(session.library.settings.transcriptionModel).toBe(
			'verification-model',
		);
		// It was the guard's answer. Nothing answered for the opening unseen.
		expect(counts).toEqual({ started: 0, stopped: 0 });
		mounted.release();
	});

test('a start that fails with a close pending answers nothing until everything it opened is released, and then hands over', async () => {
	const { test, open, begun, failWith } = await starting('read');
	// The workspace takes a moment to close, as a folder with work under way does.
	const closing = deferred<void>();
	const release = test.workspace.close;
	let closeBegan = false;
	const slowToClose = async () => {
		const opened = await open();
		return Ok({
			...expectOk(opened),
			async close() {
				closeBegan = true;
				await closing.promise;
				await release();
			},
		});
	};
	const seen: { closes: number; answers: number }[] = [];
	const mounted = mountSession(slowToClose, () => {
		seen.push({ closes: test.closes, answers: test.answers.length });
		return () => {};
	});
	await begun();
	test.requestClose();

	failWith(new Error('the first read failed'));
	await until(() => closeBegan, 'the failed session to start closing');
	await Bun.sleep(40);
	// The read has failed, but the folder is not released yet: still nothing answers.
	expect(seen).toEqual([]);
	expect(test.answers).toEqual([]);

	closing.resolve();
	await expect(mounted.opening).rejects.toThrow('the first read failed');
	await Bun.sleep(0);

	// Only now does the failed-opening answer take over, with the folder
	// released, no guard ever having listened, and no answer given before it.
	expect(seen).toEqual([{ closes: 1, answers: 0 }]);
	expect(test.closeListeners.size).toBe(0);
	mounted.release();
});

test('a layout released while its session is starting leaves nothing listening and nothing open, and answers nothing', async () => {
	const { test, open, begun, finish } = await starting('write');
	const { counts, answerClose } = closeAnswerer();
	const mounted = mountSession(open, answerClose);
	await begun();

	mounted.release();
	test.requestClose();
	finish();

	await expect(mounted.opening).rejects.toThrow('released');
	await Bun.sleep(20);
	// The write it had admitted was allowed to land before the folder closed.
	expect(await Bun.file(`${test.root}/kv.json`).exists()).toBe(true);
	expect(test.closes).toBe(1);
	expect(test.closeListeners.size).toBe(0);
	expect(test.answers).toEqual([]);
	expect(counts).toEqual({ started: 0, stopped: 0 });
});

test('a layout released while its workspace is still opening closes that workspace without starting a session', async () => {
	const test = await openTestWorkspace();
	cleanups.push(test.remove);
	let reads = 0;
	const { folder } = test.workspace;
	const counted: Workspace = {
		...test.workspace,
		folder: {
			...folder,
			kv: {
				...folder.kv,
				get: () => {
					reads += 1;
					return folder.kv.get();
				},
			},
		},
	};
	const opened = deferred<void>();
	const { counts, answerClose } = closeAnswerer();
	const mounted = mountSession(async () => {
		await opened.promise;
		return Ok(counted);
	}, answerClose);

	mounted.release();
	opened.resolve();

	await expect(mounted.opening).rejects.toThrow('released');
	expect(reads).toBe(0);
	expect(test.closes).toBe(1);
	expect(test.closeListeners.size).toBe(0);
	expect(counts).toEqual({ started: 0, stopped: 0 });
});
