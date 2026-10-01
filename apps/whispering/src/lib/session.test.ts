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

const { openSession } = await import('./session.svelte.ts');
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
