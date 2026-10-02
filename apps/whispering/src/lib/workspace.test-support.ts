/**
 * A workspace for tests: a real directory and Git repository, a fixture
 * capture device, and stubbed endpoints. Nothing here reaches a network, a
 * microphone, or a provider.
 *
 * The folder is opened with the Bun directory opener. It keeps the same
 * contract as the desktop shell's owner over the same kind of directory, and
 * is what a test can open without a shell. It is not that owner: nothing here
 * establishes how the Rust owner behaves.
 *
 * The endpoint stubs are plain functions, so a test decides each answer and
 * counts each request.
 */
import { mkdirSync, rmdirSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileError, openFolder } from '@epicenter/folder/bun';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { createFixtureDevice, toneWav } from './capture.js';
import { whisperingDefinition } from './definition.js';
import type {
	CloseDecision,
	WhisperingFolder,
	Workspace,
} from './workspace/types.js';

type TransformRequest = Parameters<Workspace['transform']>[0];

/** A real directory opened as Whispering's folder, by this test process. */
export async function openTestFolder(
	root: string,
	git: { commitOnEdit?: boolean } = {},
) {
	return expectOk(
		await openFolder({
			root,
			definition: whisperingDefinition,
			git: { author: { name: 'Test', email: 'test@localhost' }, ...git },
		}),
	);
}

/** How many upcoming recording publications fail, and at which step. */
export type RecordingFailures = {
	/** Fail at the audio, the batch's first step: nothing reaches the folder. */
	audio: number;
	/** Fail at the row, after the audio landed: a real partial publication. */
	row: number;
};

/**
 * The folder's own `batch`, with a real failure in the way of a recording's
 * publication while `failures` has any left.
 *
 * Nothing is answered on the folder's behalf. An empty directory is put at
 * the path of the step that should fail, from inside the batch callback, so
 * it is there before the folder publishes. The folder then fails that step
 * itself and reports what it reports for a real disk: a plain refusal when
 * the audio is obstructed, `Partial` with the audio applied when the row is.
 */
export function batchWithRecordingFailures(
	folder: Pick<WhisperingFolder, 'batch'>,
	root: string,
	failures: RecordingFailures,
): WhisperingFolder['batch'] {
	return async (collect) => {
		let obstacle: string | undefined;
		const result = await folder.batch((batch) => {
			let audioPath: string | undefined;
			let stem: string | undefined;
			collect({
				files: {
					...batch.files,
					create(path, content) {
						audioPath ??= path;
						batch.files.create(path, content);
					},
				},
				tables: {
					...batch.tables,
					recordings: {
						create(input) {
							stem = input.stem;
							batch.tables.recordings.create(input);
						},
					},
				},
			});
			if (stem === undefined) return undefined;
			let target: string | undefined;
			if (failures.audio > 0 && audioPath !== undefined) {
				failures.audio -= 1;
				target = audioPath;
			} else if (failures.row > 0) {
				failures.row -= 1;
				target = `recordings/${stem}.md`;
			}
			if (target !== undefined) {
				obstacle = join(root, target);
				mkdirSync(obstacle, { recursive: true });
			}
			return undefined;
		});
		if (obstacle !== undefined) rmdirSync(obstacle);
		return result;
	};
}

export type TestWorkspaceOptions = {
	/** Replace the stubbed transcription answer. */
	transcribe?: Workspace['transcribe'];
	/** Replace the stubbed transformation answer. */
	transform?: Workspace['transform'];
	/** Fail this many recording saves before any file is written, so the capture stays pending. */
	failAudioWrites?: number;
	/** Fail this many recording saves at the row, after the audio is written. */
	failRowWrites?: number;
	/** Fail this many transformation result writes before any byte is written. */
	failRunWrites?: number;
	/** Report this many transformation result writes as failed after the file landed. */
	loseRunWriteAnswers?: number;
};

export async function openTestWorkspace({
	transcribe,
	transform,
	failAudioWrites = 0,
	failRowWrites = 0,
	failRunWrites = 0,
	loseRunWriteAnswers = 0,
}: TestWorkspaceOptions = {}) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-workspace-')),
	);
	const folder = await openTestFolder(root);
	let remainingFailures = failRunWrites;
	let remainingLostAnswers = loseRunWriteAnswers;
	const runs = folder.tables.transformation_runs;
	const refused = (stem: string | undefined) =>
		FileError.Io({
			path: `transformation_runs/${stem}.md`,
			operation: 'create',
			cause: new Error('disk refused the result'),
		});
	const tables = {
		...folder.tables,
		transformation_runs: {
			...runs,
			create: async (input: Parameters<typeof runs.create>[0]) => {
				if (remainingFailures > 0) {
					remainingFailures -= 1;
					return refused(input.stem);
				}
				const created = await runs.create(input);
				if (remainingLostAnswers > 0 && created.error === null) {
					remainingLostAnswers -= 1;
					return refused(input.stem);
				}
				return created;
			},
		},
	};

	const transformed: TransformRequest[] = [];
	const answers: CloseDecision[] = [];
	const closeListeners = new Set<() => void>();
	/** A close the shell asked for while nothing was listening. */
	let closeAsked = false;
	const terminalRuns: string[] = [];
	let cwd = '/';
	let opens = 0;
	let closes = 0;

	const workspace: Workspace = {
		kind: 'native',
		folder: {
			...folder,
			tables,
			batch: batchWithRecordingFailures(folder, root, {
				audio: failAudioWrites,
				row: failRowWrites,
			}),
		} as Workspace['folder'],
		location: root,
		terminal: {
			get cwd() {
				return cwd;
			},
			async exec(command) {
				terminalRuns.push(command);
				if (command.startsWith('cd ')) cwd = `/${command.slice(3)}`;
				return { stdout: `ran ${command}\n`, stderr: '', exitCode: 0 };
			},
		},
		terminalNote: 'test',
		capture: createFixtureDevice({
			name: 'tone.wav',
			load: async () => ({ name: 'tone.wav', bytes: toneWav() }),
		}),
		captureNotice: undefined,
		onExternalChange: () => () => {},
		reveal: undefined,
		transcribe: transcribe ?? (async () => Ok({ text: 'um so a steady tone' })),
		async transform(request) {
			transformed.push(request);
			if (transform !== undefined) return transform(request);
			return Ok({ text: `Transformed: ${request.input.trim()}` });
		},
		transformNote: 'test',
		closing: {
			// As the desktop workspace does: a request with nobody listening is
			// kept and handed to the first listener.
			onRequest(listener) {
				closeListeners.add(listener);
				if (closeAsked) {
					closeAsked = false;
					listener();
				}
				return () => closeListeners.delete(listener);
			},
			async answer(decision) {
				answers.push(decision);
			},
			onRequestWithoutHost: () => () => {},
			quitWithoutHost() {},
		},
		credential: {
			storedIn: 'test',
			readOnlyReason: undefined,
			present: async () => false,
			set: async () => undefined,
		},
		preferences: {
			microphone: async () => undefined,
			setMicrophone: async () => undefined,
		},
		initialSettings: {
			transcriptionBaseUrl: 'http://127.0.0.1:18080/v1',
			transcriptionModel: 'verification-model',
		},
		debugControls: true,
		injection: undefined,
		async close() {
			closes += 1;
			await folder.close();
		},
	};

	return {
		root,
		workspace,
		/** What `openSession` is given: it counts how many times a folder was opened. */
		open: async () => {
			opens += 1;
			return Ok(workspace);
		},
		/** Every transformation request the endpoint stub received, in order. */
		transformed,
		answers,
		closeListeners,
		/** The shell asks to close, as the workspace delivers it: now, or kept. */
		requestClose() {
			if (closeListeners.size === 0) closeAsked = true;
			for (const listener of closeListeners) listener();
		},
		terminalRuns,
		get opens() {
			return opens;
		},
		get closes() {
			return closes;
		},
		remove: () => rm(root, { recursive: true, force: true }),
	};
}

/** A promise a test settles by hand, to hold a request open. */
export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}
