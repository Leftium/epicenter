/**
 * What the page answers when the desktop shell asks to close, driven against
 * the real product state over a real folder.
 *
 * Key behaviors:
 * - Nothing held: the page answers `proceed` with no prompt
 * - Typing that can be saved is saved first, then `proceed`
 * - A pending capture, an unsaved transcript or transformation result, a live
 *   recording, or typing that cannot be saved: the page answers `asking` and
 *   shows its prompt
 * - "Keep working" answers `cancel` and every held byte is still there
 * - "Discard and quit" answers `proceed`
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileError } from '@epicenter/folder/bun';
import { Ok } from 'wellcrafted/result';
import { createFixtureDevice, toneWav } from './capture.js';
import type { Library } from './library.svelte.js';
import type { CloseDecision, Workspace } from './workspace/types.js';
import {
	batchWithRecordingFailures,
	openTestFolder,
} from './workspace.test-support.js';

const { createLibrary } = await import('./library.svelte.ts');
const { createLeaveGuard } = await import('./leave.svelte.ts');
const { patchRow } = await import('./editor.svelte.ts');

const opened: Library[] = [];
const roots: string[] = [];

afterEach(async () => {
	for (const library of opened.splice(0)) await library.close();
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function open({
	failAudioWrites = 0,
	failResultWrites = 0,
	failOutputWrites = 0,
	failPrepare = false,
}: {
	failAudioWrites?: number;
	failResultWrites?: number;
	/** Fail this many transformation result writes. */
	failOutputWrites?: number;
	/** Make finding out what is held throw. */
	failPrepare?: boolean;
} = {}) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-leave-')),
	);
	roots.push(root);
	const folder = await openTestFolder(root);
	let resultFailures = failResultWrites;
	let outputFailures = failOutputWrites;
	const { transcriptions, transformation_runs } = folder.tables;
	// The acceptance case: the audio write fails, so no file reaches the folder.
	const batch = batchWithRecordingFailures(folder, root, {
		audio: failAudioWrites,
		row: 0,
	});
	const refused = (path: string) =>
		FileError.Io({ path, operation: 'create', cause: new Error('disk full') });
	const tables = {
		...folder.tables,
		transformation_runs: {
			...transformation_runs,
			create: async (
				input: Parameters<typeof transformation_runs.create>[0],
			) => {
				if (outputFailures === 0) return transformation_runs.create(input);
				outputFailures -= 1;
				return refused(`transformation_runs/${input.stem}.md`);
			},
		},
		transcriptions: {
			...transcriptions,
			create: async (input: Parameters<typeof transcriptions.create>[0]) => {
				if (resultFailures === 0) return transcriptions.create(input);
				resultFailures -= 1;
				return refused('transcriptions/result.md');
			},
		},
	};
	const answers: CloseDecision[] = [];
	const requestListeners = new Set<() => void>();
	const hostGoneListeners = new Set<() => void>();
	let quitSignals = 0;
	const workspace: Workspace = {
		kind: 'native',
		folder: { ...folder, tables, batch } as Workspace['folder'],
		location: root,
		terminal: {
			cwd: '/',
			exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		},
		terminalNote: 'test',
		capture: createFixtureDevice({
			name: 'tone.wav',
			load: async () => ({ name: 'tone.wav', bytes: toneWav() }),
		}),
		captureNotice: undefined,
		onExternalChange: () => () => {},
		reveal: undefined,
		transcribe: async () => Ok({ text: 'a steady tone' }),
		transform: async ({ input }) => Ok({ text: `Cleaned: ${input.trim()}` }),
		transformNote: 'test',
		closing: {
			onRequest(listener) {
				requestListeners.add(listener);
				return () => requestListeners.delete(listener);
			},
			async answer(decision) {
				answers.push(decision);
			},
			onRequestWithoutHost(listener) {
				hostGoneListeners.add(listener);
				return () => hostGoneListeners.delete(listener);
			},
			quitWithoutHost() {
				quitSignals += 1;
			},
		},
		credential: {
			storedIn: 'test',
			readOnlyReason: undefined,
			present: async () => false,
			set: async () => undefined,
		},
		initialSettings: {
			transcriptionBaseUrl: 'http://127.0.0.1:18080/v1',
			transcriptionModel: 'verification-model',
		},
		debugControls: true,
		injection: undefined,
		close: () => folder.close(),
	};
	const library = createLibrary(workspace);
	opened.push(library);
	await library.start();
	const guard = createLeaveGuard(
		failPrepare
			? {
					prepareToLeave: async () => {
						throw new Error('the folder host went away');
					},
					get unsavedWork() {
						return library.unsavedWork;
					},
				}
			: library,
		workspace.closing,
	);
	/** The shell asks to close, exactly as the workspace delivers it. */
	async function ask() {
		const before = answers.length;
		for (const listener of requestListeners) listener();
		// Settled when the page has gone past its acknowledgement: it either
		// proceeded or put up its prompt.
		for (let waited = 0; waited < 200; waited++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			if (
				answers.length > before &&
				(guard.asking || answers.at(-1) === 'proceed')
			)
				return;
		}
		throw new Error('the page never settled a close request');
	}
	return {
		library,
		guard,
		root,
		answers,
		ask,
		listeners: requestListeners,
		/** The shell tried to close but its host is gone. */
		askWithoutHost() {
			for (const listener of hostGoneListeners) listener();
		},
		get quitSignals() {
			return quitSignals;
		},
	};
}

async function record(library: Library) {
	await library.startRecording();
	await library.stopRecording();
}

test('with everything saved, a close request is acknowledged and proceeds without a prompt', async () => {
	const { library, guard, answers, ask } = await open();
	await record(library);

	await ask();

	expect(answers).toEqual(['asking', 'proceed']);
	expect(guard.asking).toBe(false);
});

test('typing that can be saved is saved first, then the close proceeds', async () => {
	const { library, guard, answers, ask, root } = await open();
	await record(library);
	const selection = library.selection;
	if (selection?.kind !== 'recording') throw new Error('expected a recording');
	patchRow(selection.editor, { fields: { title: 'Typed just now' } });
	expect(selection.editor.dirty).toBe(true);

	await ask();

	expect(answers).toEqual(['asking', 'proceed']);
	expect(guard.asking).toBe(false);
	expect(selection.editor.dirty).toBe(false);
	const saved = await Bun.file(join(root, selection.editor.path)).text();
	expect(saved).toContain('title: Typed just now');
});

test('a capture that reached no file blocks the close, and cancelling keeps its audio', async () => {
	const { library, guard, answers, ask, root } = await open({
		failAudioWrites: 1,
	});
	await record(library);
	expect(library.pending).toHaveLength(1);
	const pending = library.pending[0]!;
	expect(pending.state.kind).toBe('failed');
	expect(
		await readdir(join(root, 'recordings')).catch(() => [] as string[]),
	).toEqual([]);

	await ask();

	// Acknowledged, never approved.
	expect(answers).toEqual(['asking']);
	expect(guard.asking).toBe(true);
	expect(guard.hostGone).toBe(false);
	expect(guard.held.join(' ')).toContain('1 recording is not saved');

	await guard.stay();

	expect(answers).toEqual(['asking', 'cancel']);
	expect(guard.asking).toBe(false);
	// The same capture, id, and bytes are still in the window, and still retryable.
	expect(library.pending[0]!.capture.id).toBe(pending.capture.id);
	expect(library.pending[0]!.capture.bytes).toEqual(toneWav());
	await library.retryPending(pending.capture.id);
	expect(library.pending).toHaveLength(0);
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual([
		`${pending.capture.id}.md`,
		`${pending.capture.id}.wav`,
	]);

	// With it saved, the next close needs no prompt.
	await ask();
	expect(answers).toEqual(['asking', 'cancel', 'asking', 'proceed']);
});

test('discard and quit is the only answer that drops a pending capture', async () => {
	const { library, guard, answers, ask } = await open({ failAudioWrites: 1 });
	await record(library);

	await ask();
	// A second request while the prompt is up is acknowledged and changes nothing.
	await ask();
	expect(answers).toEqual(['asking', 'asking']);
	expect(guard.asking).toBe(true);
	expect(library.pending).toHaveLength(1);

	await guard.discardAndQuit();

	expect(answers).toEqual(['asking', 'asking', 'proceed']);
});

test('a live recording blocks the close', async () => {
	const { library, guard, answers, ask } = await open();
	await library.startRecording();

	await ask();

	expect(answers).toEqual(['asking']);
	expect(guard.held).toContain('A recording is in progress.');
	await guard.stay();
	expect(library.recorder.phase).toBe('recording');
	await library.stopRecording();
	expect(library.entries).toHaveLength(1);
});

test('a transcript whose file was not saved blocks the close', async () => {
	const { library, guard, answers, ask } = await open({ failResultWrites: 1 });
	await record(library);
	await library.transcribe(library.entries[0]!);

	await ask();

	expect(answers).toEqual(['asking']);
	expect(guard.held.join(' ')).toContain('1 transcript arrived');
	await guard.stay();
	const run = library.transcriptionRun(library.entries[0]!.stem!);
	expect(run?.kind).toBe('unsaved');
	if (run?.kind === 'unsaved') expect(run.text).toBe('a steady tone');
});

test('a transformation result whose file was not saved blocks the close and is kept', async () => {
	const { library, guard, answers, ask } = await open({ failOutputWrites: 1 });
	await record(library);
	await library.transcribe(library.entries[0]!);
	expect(
		await library.createTransformation({
			title: 'Clean up',
			prompt: 'Tidy.\n',
		}),
	).toBeUndefined();
	const profile = library.selectedTransformation!;
	patchRow(profile.editor, { fields: { model: 'chat-model' } });
	const transcript = library.resultsFor(library.entries[0]!.stem!)[0]!;
	expect(
		await library.transform(transcript.path, profile.editor.path),
	).toBeUndefined();

	await ask();

	expect(answers).toEqual(['asking']);
	expect(guard.held.join(' ')).toContain(
		'1 transformation result arrived but its file is not saved.',
	);
	await guard.stay();
	const run = library.transformationRuns[0]!;
	expect(run.state.kind).toBe('unsaved');
	if (run.state.kind === 'unsaved')
		expect(run.state.text).toBe('Cleaned: a steady tone');

	// Once it is saved, nothing is held and the close proceeds without a prompt.
	await library.retryTransformation(run.id);
	await ask();
	expect(answers).toEqual(['asking', 'cancel', 'asking', 'proceed']);
});

test('a transformation draft that cannot be saved blocks the close and stays in the editor', async () => {
	const { library, guard, answers, ask } = await open();
	await library.createTransformation({ title: 'Clean up', prompt: 'Tidy.\n' });
	const { editor } = library.selectedTransformation!;
	library.autosave.paused = true;
	patchRow(editor, { body: 'A prompt typed and not saved.\n' });

	await ask();

	expect(answers).toEqual(['asking']);
	expect(guard.held).toContain(`${editor.path} has unsaved edits.`);
	await guard.stay();
	expect(editor.buffer).toContain('A prompt typed and not saved.');
	expect(editor.dirty).toBe(true);
});

test('typing that cannot be saved blocks the close and stays in the editor', async () => {
	const { library, guard, answers, ask } = await open();
	await record(library);
	const selection = library.selection;
	if (selection?.kind !== 'recording') throw new Error('expected a recording');
	library.autosave.paused = true;
	patchRow(selection.editor, { fields: { title: 'Held back' } });

	await ask();

	expect(answers).toEqual(['asking']);
	expect(guard.held).toContain(`${selection.editor.path} has unsaved edits.`);
	await guard.stay();
	expect(selection.editor.buffer).toContain('title: Held back');
	expect(selection.editor.dirty).toBe(true);
});

test('when what is held cannot be determined, the page asks instead of proceeding', async () => {
	const { guard, answers, ask } = await open({ failPrepare: true });

	await ask();

	expect(answers).toEqual(['asking']);
	expect(guard.asking).toBe(true);
	await guard.stay();
	expect(answers).toEqual(['asking', 'cancel']);
});

test('with the host gone, a close attempt keeps the window and the pending audio', async () => {
	const started = await open({ failAudioWrites: 1 });
	const { library, guard, answers } = started;
	await record(library);
	const pending = library.pending[0]!;

	started.askWithoutHost();

	expect(guard.asking).toBe(true);
	expect(guard.hostGone).toBe(true);
	expect(guard.held.join(' ')).toContain('1 recording is not saved');
	// Nothing is sent to a host that is not there, and nothing has quit.
	expect(answers).toEqual([]);
	expect(started.quitSignals).toBe(0);

	await guard.stay();

	expect(guard.asking).toBe(false);
	expect(started.quitSignals).toBe(0);
	expect(library.pending[0]!.capture.id).toBe(pending.capture.id);
	expect(library.pending[0]!.capture.bytes).toEqual(toneWav());

	// Only the explicit choice quits, through the shell's direct signal.
	started.askWithoutHost();
	await guard.discardAndQuit();
	expect(started.quitSignals).toBe(1);
	expect(answers).toEqual([]);
});

test('the guard stops listening when the view goes away', async () => {
	const { guard, listeners } = await open();
	expect(listeners.size).toBe(1);
	guard.dispose();
	expect(listeners.size).toBe(0);
});
