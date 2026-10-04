/**
 * Whispering workflow tests
 *
 * Drives the real product state against a real directory and Git repository,
 * with a fixture capture device and a stubbed transcription answer. No window,
 * shell, or microphone is involved, so these establish the workflow's logic and
 * what it leaves on disk, not that the desktop app runs.
 *
 * Key behaviors:
 * - A first launch creates no files or history, and saving a connection
 *   writes nothing to the folder
 * - `kv.json` from an earlier build is read and reported, never written, and
 *   never where a request goes
 * - Record, stop, and save produce audio, a row that names it, and a commit
 * - Captured audio and its id survive a row write that fails after the
 *   audio landed, and an explicit retry finishes one recording
 * - A row that names no audio says so: nothing is guessed from a file's name
 * - Deleting a recording deletes its row and results and keeps its audio. A
 *   draft of one of its results that holds anything refuses the deletion;
 *   while it runs, those drafts take no typing and write nothing
 * - A rename and a deletion that share a path, as source or destination,
 *   never overlap: the later one is refused before it reads or writes
 * - A recording is edited through the folder's row editor; its Source shows
 *   what a save writes, and its whole text can be edited instead
 * - A clean editor follows an outside edit; a dirty one keeps both versions
 * - A malformed row stays listed and selectable, is edited as its text, saves
 *   while malformed, and its source is untouched until the person changes it
 * - Typing with a field issue is held and says so; nothing with an issue is
 *   saved by the form
 * - A recording with an unusual file name is an ordinary recording at its
 *   literal ID: transcribed, edited, reviewed, and deleted like any other
 * - A recording is not deleted while a result cannot say which recording it
 *   belongs to
 * - A transcription result is its own row naming the recording
 * - Reopening the folder shows the same recordings and results
 * - A received transcript has one file name: saving it again never calls the
 *   endpoint, recognizes a save that landed with its reply lost, leaves
 *   another file at that name alone, and cannot write a second result
 * - A held transcript refuses a new request, and a save that finishes late
 *   restores nothing that was discarded and replaces nothing newer
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileError, MoveError } from '@epicenter/folder/bun';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { loadAudio } from './audio-source.js';
import { createFixtureDevice, toneWav } from './capture.js';
import { describeDeletion } from './deletion-copy.js';
import type { Library } from './library.svelte.js';
import { needsRepair } from './rows.js';
import {
	commitLine,
	filesLine,
	filesLineOf,
	summaryLine,
	uncommittedLine,
} from './status.js';
import type { Workspace } from './workspace/types.js';
import { formOf, textOf } from './row-slot.test-support.js';
import {
	openTestFolder,
	TEST_BASE_URL,
	testConnections,
	testInjection,
} from './workspace.test-support.js';

const { createLibrary } = await import('./library.svelte.ts');

const opened: Library[] = [];
const roots: string[] = [];

type Options = {
	/** Fail this many recording row writes after the audio lands. */
	failRowWrites?: number;
	/** Fail this many transcription result row writes. */
	failResultWrites?: number;
	/** Report this many transcription result row writes as unconfirmed after the file landed. */
	loseResultReplies?: number;
	/** Replace the stubbed transcription answer. */
	transcribe?: Workspace['transcribe'];
	root?: string;
	beforeFileCreate?: () => Promise<void>;
	/** Stand in front of the folder's settings methods; `real` is the folder's own. */
	kv?: (real: Kv, externalChange: () => void) => Kv;
	/** What the device has set up. Both connections, keyless, unless a test says otherwise. */
	connections?: Parameters<typeof testConnections>[0];
};
type Kv = Workspace['folder']['kv'];

async function open({
	failRowWrites = 0,
	failResultWrites = 0,
	loseResultReplies = 0,
	transcribe,
	beforeFileCreate,
	root,
	kv,
	connections,
}: Options = {}) {
	const directory =
		root ??
		(await realpath(await mkdtemp(join(tmpdir(), 'whispering-library-'))));
	if (root === undefined) roots.push(directory);
	const folder = await openTestFolder(directory);
	/** Result row writes still to fail. A test may arm more after opening. */
	const failures = { resultWrites: failResultWrites };
	let remainingLostReplies = loseResultReplies;
	const transcriptions = folder.tables.transcriptions;
	const tables = {
		...folder.tables,
		transcriptions: {
			...transcriptions,
			create: async (input: Parameters<typeof transcriptions.create>[0]) => {
				if (failures.resultWrites > 0) {
					failures.resultWrites -= 1;
					return FileError.Io({
						path: 'transcriptions/result.md',
						operation: 'create',
						cause: new Error('disk refused the result'),
					});
				}
				const created = await transcriptions.create(input);
				const { data: row, error: createError } = created;
				if (remainingLostReplies === 0 || createError !== null) return created;
				remainingLostReplies -= 1;
				return FileError.Unconfirmed({
					path: row.path,
					operation: 'create',
					cause: 'reply lost after the write',
				});
			},
		},
	};
	const transcribed: Parameters<Workspace['transcribe']>[0][] = [];
	const device = testConnections(connections);
	const changeListeners = new Set<() => void>();
	const workspace: Workspace = {
		kind: 'native',
		folder: {
			...folder,
			tables,
			kv:
				kv?.(folder.kv, () => {
					for (const listener of changeListeners) listener();
				}) ?? folder.kv,
			files: {
				...folder.files,
				async create(path, content) {
					await beforeFileCreate?.();
					return folder.files.create(path, content);
				},
			},
		} as Workspace['folder'],
		location: directory,
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
		onExternalChange(listener) {
			changeListeners.add(listener);
			return () => changeListeners.delete(listener);
		},
		reveal: undefined,
		async transcribe(request) {
			transcribed.push(request);
			if (transcribe !== undefined) return transcribe(request);
			return Ok({ text: 'a steady tone' });
		},
		transform: async ({ input }) => Ok({ text: input }),
		transformNote: 'test',
		closing: undefined,
		connections: device.member,
		preferences: {
			microphone: async () => undefined,
			setMicrophone: async () => undefined,
		},
		debugControls: true,
		// A debug shell's injection: the row write fails after the audio landed.
		injection: testInjection(directory, { audio: 0, row: failRowWrites }),
		close: () => folder.close(),
	};
	const library = createLibrary(workspace);
	opened.push(library);
	await library.start();
	return { library, root: directory, transcribed, failures, device };
}

afterEach(async () => {
	for (const library of opened.splice(0)) await library.close();
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]) =>
	execFileSync('git', args, { cwd: root, encoding: 'utf8' });

async function record(library: Library) {
	await library.startRecording();
	expect(library.recorder.phase).toBe('recording');
	await library.stopRecording();
}

/** The selected recording's slot: its row editor, or its text. */
function recordingSlot(library: Library) {
	const selection = library.selection;
	if (selection?.kind !== 'recording')
		throw new Error(`Expected a recording, got ${selection?.kind}`);
	return selection.slot;
}

/** The selected recording's row editor. */
const recordingEditor = (library: Library) => formOf(recordingSlot(library));

test('the first launch creates no files or history, and saving a connection writes nothing to the folder', async () => {
	const { library, root, device } = await open({
		connections: { connections: {} },
	});
	expect(await readdir(root)).not.toContain('kv.json');
	expect(git(root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
	expect(await Bun.file(join(root, '.git/refs/heads/main')).exists()).toBe(
		false,
	);
	expect(git(root, 'status', '--porcelain').trim()).toBe('');
	// Nothing is set up until the person saves a connection.
	expect(library.connections).toEqual({
		transcription: undefined,
		text: undefined,
		legacyKey: false,
	});
	expect(library.legacySettings).toEqual({});

	expect(
		await library.saveConnection('transcription', {
			baseUrl: `${TEST_BASE_URL}/`,
			model: ' chosen ',
			key: { action: 'replace', key: 'typed-key' },
		}),
	).toBeUndefined();

	expect(library.connections?.transcription).toEqual({
		baseUrl: TEST_BASE_URL,
		model: 'chosen',
		keyPresent: true,
		readOnlyReason: undefined,
	});
	expect(device.stored.transcription?.apiKey).toBe('typed-key');
	expect(await readdir(root)).not.toContain('kv.json');
	expect(git(root, 'status', '--porcelain').trim()).toBe('');
});

test('kv.json from an earlier build is offered, never written, and never where a request goes', async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-library-')),
	);
	roots.push(root);
	const saved =
		'{"transcriptionBaseUrl": "https://elsewhere.example/v1", "transcriptionModel": "old-model"}\n';
	await writeFile(join(root, 'kv.json'), saved);
	const { library, transcribed } = await open({ root });

	expect(library.legacySettings).toEqual({
		transcriptionBaseUrl: 'https://elsewhere.example/v1',
		transcriptionModel: 'old-model',
	});
	await record(library);
	await library.transcribe(library.entries[0]!);

	// The request is prepared for the device's connection, never kv.json's.
	expect(transcribed).toEqual([
		expect.objectContaining({
			expectedBaseUrl: TEST_BASE_URL,
			model: 'verification-model',
		}),
	]);
	expect(library.resultsFor(library.entries[0]!.stem)[0]!.fields).toMatchObject(
		{ endpoint: TEST_BASE_URL, model: 'verification-model' },
	);
	expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe(saved);
});

test('with no transcription connection, transcribing sends nothing and says to set one up', async () => {
	const { library, transcribed } = await open({
		connections: { connections: {} },
	});
	await record(library);
	const entry = library.entries[0]!;

	await library.transcribe(entry);

	expect(transcribed).toEqual([]);
	expect(library.transcriptionRun(entry.stem)).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('No transcription connection is set up'),
	});
	expect(library.resultsFor(entry.stem)).toEqual([]);
});

test('a launch whose kv.json read fails creates no settings file and says why', async () => {
	let creates = 0;
	const { library, root } = await open({
		kv: (real) => ({
			...real,
			get: async () =>
				FileError.Io({
					path: 'kv.json',
					operation: 'read',
					cause: new Error('disk refused the read'),
				}),
			create: async (values) => {
				creates += 1;
				return real.create(values);
			},
		}),
	});

	expect(creates).toBe(0);
	expect(await readdir(root)).not.toContain('kv.json');
	expect(library.settingsProblem).toContain('disk refused the read');
	// Nothing is offered from settings that could not be read.
	expect(library.legacySettings).toEqual({});
});

test('kv.json that does not parse, or holds a value that does not conform, is the settings problem, and only values that read are offered', async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-library-')),
	);
	roots.push(root);
	await writeFile(join(root, 'kv.json'), '{"transcriptionModel": ');
	const { library } = await open({ root });

	// A parse failure reads no values; it is reported.
	expect(library.settingsProblem).toContain('not valid JSON');
	expect(library.legacySettings).toEqual({});

	// One value that does not conform is named; the other still reads.
	await writeFile(
		join(root, 'kv.json'),
		'{"transcriptionModel": 7, "transcriptionBaseUrl": "http://kept"}\n',
	);
	await library.refreshAll();
	expect(library.settingsProblem).toContain('transcriptionModel');
	expect(library.legacySettings).toEqual({
		transcriptionBaseUrl: 'http://kept',
	});

	// Healthy text has no issues, and no issues is no problem at all.
	await writeFile(join(root, 'kv.json'), '{"transcriptionModel": "kept"}\n');
	await library.refreshAll();
	expect(library.settingsProblem).toBeUndefined();
	expect(library.legacySettings).toEqual({ transcriptionModel: 'kept' });
});

test('a launch whose first listing is superseded does not seed over settings it never saw', async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-library-')),
	);
	roots.push(root);
	const existing = '{"transcriptionModel": "kept"}\n';
	await writeFile(join(root, 'kv.json'), existing);
	const held = Promise.withResolvers<void>();
	let reads = 0;
	let creates = 0;

	const { library } = await open({
		root,
		kv: (real, externalChange) => ({
			...real,
			get: async () => {
				reads += 1;
				const read = reads;
				// The first listing is overtaken by an outside change whose own
				// read stays pending, so neither one records the settings.
				if (read === 1) externalChange();
				if (read === 2) await held.promise;
				return real.get();
			},
			create: async (values) => {
				creates += 1;
				return real.create(values);
			},
		}),
	});
	held.resolve();
	await library.refreshAll();

	expect(creates).toBe(0);
	expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe(existing);
	expect(library.settingsProblem).toBeUndefined();
	expect(library.legacySettings).toEqual({ transcriptionModel: 'kept' });
});

test('record, stop, and save leave a row, real audio, and a commit', async () => {
	const { library, root } = await open();

	await record(library);

	expect(library.pending).toHaveLength(0);
	expect(library.entries).toHaveLength(1);
	const entry = library.entries[0]!;
	expect(needsRepair(entry)).toBe(false);
	expect(entry.fields.capture).toBe('fixture');
	expect(entry.fields.durationMs).toBe(1000);
	expect(entry.fields.audioPath).toBe(`recordings/${entry.stem}.wav`);
	expect(library.selectedPath).toBe(entry.path);
	expect(
		new Uint8Array(await readFile(join(root, entry.fields.audioPath!))),
	).toEqual(new Uint8Array(toneWav()));

	const outcome = await library.commit();
	expect(['committed', 'unchanged']).toContain(outcome.status);
	const tree = git(root, 'ls-tree', '-r', '--name-only', 'HEAD');
	expect(tree).toContain(entry.path);
	expect(tree).toContain(entry.fields.audioPath!);
	expect(tree).not.toContain('kv.json');
});

test('a row write that fails after the audio landed keeps the capture and its id, and an explicit retry makes one recording', async () => {
	const { library, root } = await open({ failRowWrites: 1 });

	await record(library);

	expect(library.entries).toHaveLength(0);
	expect(library.pending).toHaveLength(1);
	const pending = library.pending[0]!;
	// The audio write's own receipt survives the row's failure.
	expect(pending.state).toMatchObject({
		kind: 'rowNotSaved',
		certainty: 'failed',
		audio: { by: 'receipt', file: { path: pending.capture.fields.audioPath } },
	});
	expect(pending.capture.bytes).toEqual(toneWav());
	expect(library.holdsUnsavedWork).toBe(true);
	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${pending.capture.id}.wav`,
	]);

	await library.retryPending(pending.capture.id);

	expect(library.pending).toHaveLength(0);
	expect(library.entries).toHaveLength(1);
	expect(library.entries[0]!.stem).toBe(pending.capture.id);
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual([
		`${pending.capture.id}.md`,
		`${pending.capture.id}.wav`,
	]);
});

test('the title and notes are one row draft saved whole, and editing the text is the same file’s one draft', async () => {
	const { library, root } = await open();
	await record(library);
	const editor = recordingEditor(library);
	const { path } = editor;
	library.autosave.paused = true;

	expect(editor.change({ fields: { title: 'Standup notes' } })).toBe(true);
	expect(editor.change({ body: 'Typed as notes\n' })).toBe(true);
	// Source shows exactly what a save will write.
	expect(editor.state.source).toContain('"title": "Standup notes"');
	expect(editor.state.source.endsWith('---\nTyped as notes\n')).toBe(true);
	expect(editor.isDirty).toBe(true);
	await editor.saveNow();

	expect(editor.status.kind).toBe('saved');
	expect(await readFile(join(root, path), 'utf8')).toBe(editor.state.source);
	await library.refresh();
	expect(library.entries[0]!.fields.title).toBe('Standup notes');
	expect(library.entries[0]!.body).toBe('Typed as notes\n');
	expect(await library.rename(path, 'other.md')).toContain('named by its ID');

	// Editing the whole text puts the form down and holds the file's text instead.
	expect(await library.editSource(path)).toBeUndefined();
	const text = textOf(recordingSlot(library));
	expect(text.buffer).toBe(await readFile(join(root, path), 'utf8'));
	text.input(`${text.buffer}Typed in the source view\n`);
	await text.save();
	expect(await readFile(join(root, path), 'utf8')).toContain(
		'Typed in the source view',
	);
	// Back to the fields, which read the file as it is now.
	expect(await library.useForm(path)).toBeUndefined();
	expect(recordingEditor(library).state.document.body).toBe(
		'Typed as notes\nTyped in the source view\n',
	);
});

test('the text is not taken over while the form holds unsaved typing', async () => {
	const { library } = await open();
	await record(library);
	const editor = recordingEditor(library);
	library.autosave.paused = true;
	editor.change({ fields: { title: 'Unsaved' } });

	expect(await library.editSource(editor.path)).toContain('Save or discard');
	expect(recordingEditor(library)).toBe(editor);
	expect(editor.state.document.fields.title).toBe('Unsaved');
});

test('a clean editor follows an outside edit', async () => {
	const { library, root } = await open();
	await record(library);
	const editor = recordingEditor(library);
	const path = join(root, editor.path);

	await writeFile(
		path,
		(await readFile(path, 'utf8')).replace(
			/title: .*/,
			'title: Edited outside',
		),
	);
	await library.refreshAll();

	expect(editor.status.kind).toBe('saved');
	expect(editor.isDirty).toBe(false);
	expect(editor.state.document.fields.title).toBe('Edited outside');
	expect(library.entries[0]!.fields.title).toBe('Edited outside');
});

test('a dirty editor keeps both versions when the file changes outside, until a choice', async () => {
	const { library, root } = await open();
	await record(library);
	const editor = recordingEditor(library);
	const path = join(root, editor.path);
	editor.change({ fields: { title: 'Mine' } });
	expect(editor.isDirty).toBe(true);

	const outside = (await readFile(path, 'utf8')).replace(
		/title: .*/,
		'title: Theirs',
	);
	await writeFile(path, outside);
	await library.refreshAll();

	expect(editor.status.kind).toBe('changed');
	expect(editor.state.document.fields.title).toBe('Mine');
	expect(editor.review).toMatchObject({
		kind: 'changed',
		current: { source: outside },
	});
	// Nothing saves on its own while both versions stand; neither is written over.
	expect(await editor.settle()).toBe(false);
	expect(await library.prepareToLeave()).toBe(false);
	expect(await readFile(path, 'utf8')).toBe(outside);
	expect(library.saveProblems).toBe(1);
	expect(library.unsavedWork).toEqual([
		`${editor.path} has edits held in a conflict.`,
	]);

	const kept = expectOk(await library.keepDraftCopy(editor.path));
	expect(editor.status.kind).toBe('saved');
	expect(editor.state.baseline.source).toBe(outside);
	expect(editor.state.document.fields.title).toBe('Theirs');
	expect(await readFile(path, 'utf8')).toBe(outside);
	expect(await readFile(join(root, kept), 'utf8')).toContain('"title": "Mine"');
});

test('choosing mine saves the whole draft over the reviewed outside version', async () => {
	const { library, root } = await open();
	await record(library);
	const editor = recordingEditor(library);
	const path = join(root, editor.path);
	editor.change({ fields: { title: 'Mine' } });
	await writeFile(
		path,
		(await readFile(path, 'utf8')).replace(/title: .*/, 'title: Theirs'),
	);
	await library.refreshAll();
	expect(editor.status.kind).toBe('changed');

	await editor.saveNow();

	expect(editor.status.kind).toBe('saved');
	expect(await readFile(path, 'utf8')).toBe(editor.state.source);
	await library.refresh();
	expect(library.entries[0]!.fields.title).toBe('Mine');
});

test('discarding mine takes the outside version and writes nothing', async () => {
	const { library, root } = await open();
	await record(library);
	const editor = recordingEditor(library);
	const path = join(root, editor.path);
	editor.change({ fields: { title: 'Mine' } });
	const outside = (await readFile(path, 'utf8')).replace(
		/title: .*/,
		'title: Theirs',
	);
	await writeFile(path, outside);
	await library.refreshAll();

	expect(await library.discardDraft(editor.path)).toBeUndefined();

	expect(editor.isDirty).toBe(false);
	expect(editor.state.document.fields.title).toBe('Theirs');
	expect(await readFile(path, 'utf8')).toBe(outside);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('a row removed outside under unsaved typing is not written again on its own', async () => {
	const { library, root } = await open();
	await record(library);
	const editor = recordingEditor(library);
	const path = join(root, editor.path);
	editor.change({ fields: { title: 'Mine' } });
	await rm(path);
	await library.refreshAll();
	// Long enough for a save the typing would otherwise have scheduled.
	await Bun.sleep(600);

	expect(editor.status.kind).toBe('removed');
	expect(await Bun.file(path).exists()).toBe(false);
	expect(library.unsavedWork).toEqual([
		`${editor.path} has edits held in a conflict.`,
	]);

	// Discarding drops the draft; there is no file to show.
	expect(await library.discardDraft(editor.path)).toBeUndefined();
	expect(library.selection).toBeUndefined();
	expect(await Bun.file(path).exists()).toBe(false);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('a malformed row stays listed and selectable, saves while malformed, and its bytes are not rewritten', async () => {
	const { library, root } = await open();
	await record(library);
	const broken = '---\ntitle: *missing\nmood: curious\n---\nStill here\n';
	await writeFile(join(root, 'recordings', 'broken.md'), broken);
	// Markdown with no frontmatter lines does not parse either, and is listed too.
	await writeFile(join(root, 'recordings', 'plain.md'), 'Just notes\n');
	await library.refreshAll();

	const listed = (path: string) =>
		library.entries.find((item) => item.path === path);
	const entry = listed('recordings/broken.md');
	// The capture is whole; the parse failed and recovered nothing.
	expect(entry?.source).toBe(broken);
	expect(entry).toMatchObject({ fields: {}, body: undefined, issues: [] });
	expect(entry?.parseError?.diagnostics[0].message).toContain(
		'Unresolved alias',
	);
	expect(listed('recordings/plain.md')?.parseError).toBeDefined();
	// A file that was read is never among the files that could not be.
	expect(library.unreadable).toEqual([]);
	await library.open('recordings/broken.md');
	// It opens as its exact text: there are no fields to edit until it is repaired.
	expect(textOf(recordingSlot(library)).buffer).toBe(broken);
	expect(await library.useForm('recordings/broken.md')).toBeUndefined();
	const editor = textOf(recordingSlot(library));
	expect(editor.buffer).toBe(broken);
	expect(await readFile(join(root, 'recordings', 'broken.md'), 'utf8')).toBe(
		broken,
	);
	// The draft is read as typed, by the table's own interpreter.
	const inspect = library.folder.tables.recordings.inspect;
	expect(entry).toMatchObject(inspect(editor.buffer));

	// Text that is still malformed saves, and its capture is the next baseline.
	const still = broken.replace('Still here', 'Still here, still broken');
	editor.input(still);
	await editor.save();
	expect(editor.saveState).toEqual({ kind: 'saved' });
	expect(editor.baseline.source).toBe(still);
	expect(inspect(editor.baseline.source).parseError).toBeDefined();
	expect(await readFile(join(root, 'recordings', 'broken.md'), 'utf8')).toBe(
		still,
	);

	editor.input(
		'---\ntitle: Repaired\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1\ncapture: microphone\naudioPath: recordings/broken.wav\nmood: curious\n---\nStill here\n',
	);
	await editor.save();
	await library.refresh();
	const repaired = library.entries.find(
		(item) => item.path === 'recordings/broken.md',
	);
	expect(repaired && needsRepair(repaired)).toBe(false);
	expect(
		await readFile(join(root, 'recordings', 'broken.md'), 'utf8'),
	).toContain('mood: curious');

	// Repaired, it is edited as fields again, with its unknown field kept.
	expect(await library.useForm('recordings/broken.md')).toBeUndefined();
	expect(recordingEditor(library).state.document.fields).toMatchObject({
		title: 'Repaired',
		mood: 'curious',
	});
});

test('typing with a field issue is held and says so; the other fields still change and nothing with an issue is saved', async () => {
	const { library, root } = await open();
	await record(library);
	const saved = library.entries[0]!;
	await library.open(saved.path);
	const editor = recordingEditor(library);

	expect(editor.change({ fields: { durationMs: 'long' } })).toBe(true);
	const { reading } = editor.state;
	expect(reading.parseError).toBeUndefined();
	expect(reading.issues.map((issue) => issue.field)).toEqual(['durationMs']);
	// The other fields validated by themselves and are still there.
	expect(reading.fields.title).toBe(saved.fields.title);
	expect(reading.fields.audioPath).toBe(saved.fields.audioPath);
	expect(editor.status.kind).toBe('invalid');

	expect(editor.change({ fields: { title: 'Renamed' } })).toBe(true);
	expect(editor.change({ body: 'Notes\n' })).toBe(true);
	expect(editor.state.reading.fields.title).toBe('Renamed');
	expect(editor.state.reading.body).toBe('Notes\n');
	expect(editor.state.reading.issues.map((issue) => issue.field)).toEqual([
		'durationMs',
	]);
	// The form saves nothing with an issue, on its own or when settled.
	expect(await editor.settle()).toBe(false);
	expect(await readFile(join(root, saved.path), 'utf8')).toBe(saved.source);
	expect(library.holdsUnsavedWork).toBe(true);

	// Fixed, it saves with everything typed since.
	expect(editor.change({ fields: { durationMs: 1000 } })).toBe(true);
	expect(await editor.settle()).toBe(true);
	await library.refresh();
	expect(library.entries[0]!.fields).toMatchObject({
		title: 'Renamed',
		durationMs: 1000,
	});
	expect(library.entries[0]!.body).toBe('Notes\n');
});

test('a recording with an unusual file name is an ordinary recording: it is transcribed, edited, reviewed, and deleted at its literal ID', async () => {
	const { library, root, transcribed } = await open();
	await record(library);
	const recorded = library.entries[0]!;
	// The same valid row under a name with a trailing space.
	const path = 'recordings/bad .md';
	await writeFile(join(root, path), recorded.source);
	await library.refreshAll();
	const entry = library.entries.find((item) => item.path === path)!;
	expect(entry.stem).toBe('bad ');
	// A name is an address. It is never something to repair.
	expect(needsRepair(entry)).toBe(false);

	// The row names real audio, so it is transcribed like any other, and its
	// result names it by that literal ID.
	await library.transcribe(entry);
	expect(transcribed.map((request) => request.audioPath)).toEqual([
		entry.fields.audioPath!,
	]);
	expect(
		library.resultsFor('bad ').map((result) => result.fields.recordingId),
	).toEqual(['bad ']);
	expect(library.resultsFor(recorded.stem)).toEqual([]);

	await library.open(path);
	const editor = recordingEditor(library);
	library.autosave.paused = true;
	editor.change({ fields: { title: 'Mine' } });
	const outside = recorded.source.replace(/title: .*/, 'title: Theirs');
	await writeFile(join(root, path), outside);
	await library.refreshAll();
	// The draft reads this row, not a neighbor and not nothing.
	expect(editor.review).toMatchObject({
		kind: 'changed',
		current: { path, source: outside },
	});
	expect(editor.state.document.fields.title).toBe('Mine');
	expect(await readFile(join(root, path), 'utf8')).toBe(outside);

	await editor.saveNow();
	expect(editor.status.kind).toBe('saved');
	expect(await readFile(join(root, path), 'utf8')).toContain('"title": "Mine"');

	const deletion = expectOk(await library.deletionFor(path));
	expect(deletion).toMatchObject({
		kind: 'recording',
		entry: { path, stem: 'bad ' },
	});
	// Its result goes with it, found by the ID it names.
	expect(deletion?.kind === 'recording' && deletion.results).toHaveLength(1);
	expect(await library.remove(deletion!)).toBeUndefined();
	expect(library.entries.map((item) => item.path)).toEqual([recorded.path]);
	expect(library.transcriptions).toEqual([]);
});

test('a recording is not deleted while a result cannot say which recording it belongs to', async () => {
	const { library, root } = await open();
	await record(library);
	const entry = library.entries[0]!;
	await library.transcribe(entry);
	const [result] = library.resultsFor(entry.stem);
	const rowSource = await readFile(join(root, entry.path), 'utf8');
	const untouched = async () => {
		expect(await readFile(join(root, entry.path), 'utf8')).toBe(rowSource);
		expect(await readFile(join(root, result!.path), 'utf8')).toBe(
			result!.source,
		);
	};

	// Each of these might be this recording's result: its text says so, or might.
	const unknown: Record<string, string | Uint8Array> = {
		'transcriptions/unparsed.md': `---\nrecordingId: ${entry.stem}\nmodel: [open\n---\ntext\n`,
		'transcriptions/fenceless.md': `recordingId: ${entry.stem}\n`,
		'transcriptions/invalid.md': '---\nrecordingId: 12\n---\ntext\n',
		'transformation_runs/absent.md': '---\nmodel: m\n---\ntext\n',
		'transcriptions/binary.md': new Uint8Array([0xff, 0xfe, 0x00]),
	};
	await mkdir(join(root, 'transformation_runs'), { recursive: true });
	for (const [path, content] of Object.entries(unknown)) {
		await writeFile(join(root, path), content);
		await library.refreshAll();
		const { error: refusal } = await library.deletionFor(entry.path);
		expect(refusal).toContain('cannot be told apart');
		expect(refusal).toContain(path);
		await untouched();
		await rm(join(root, path));
	}

	// A deletion confirmed before such a file appeared is refused when it runs.
	await library.refreshAll();
	const confirmed = expectOk(await library.deletionFor(entry.path));
	await writeFile(
		join(root, 'transcriptions/late.md'),
		unknown['transcriptions/unparsed.md']!,
	);
	await library.refreshAll();
	expect(await library.remove(confirmed!)).toContain('cannot be told apart');
	await untouched();
	await rm(join(root, 'transcriptions/late.md'));

	// A result with issues in other fields still names its recording: enough.
	await writeFile(
		join(root, 'transcriptions/other.md'),
		'---\nrecordingId: someone-else\nmodel: 12\n---\ntext\n',
	);
	await library.refreshAll();
	const deletion = expectOk(await library.deletionFor(entry.path));
	expect(await library.remove(deletion!)).toBeUndefined();
	expect(library.entries).toEqual([]);
	expect(library.transcriptions.map((item) => item.path)).toEqual([
		'transcriptions/other.md',
	]);
});

test('a transcription is saved as its own row naming the recording', async () => {
	const { library, root, transcribed } = await open();
	await record(library);
	const entry = library.entries[0]!;

	await library.transcribe(entry);

	expect(transcribed).toEqual([
		{
			audioPath: entry.fields.audioPath!,
			expectedBaseUrl: 'http://127.0.0.1:18080/v1',
			model: 'verification-model',
		},
	]);
	const results = library.resultsFor(entry.stem);
	expect(results).toHaveLength(1);
	expect(results[0]!.body).toBe('a steady tone\n');
	const row = await readFile(join(root, results[0]!.path), 'utf8');
	expect(row).toContain(`recordingId: ${entry.stem}`);
	expect(row).toContain('model: verification-model');
	expect(row).toContain('a steady tone');
});

test('reopening the folder shows the same recording and result', async () => {
	const first = await open();
	await record(first.library);
	const entry = first.library.entries[0]!;
	await first.library.transcribe(entry);
	await first.library.commit();
	opened.splice(opened.indexOf(first.library), 1);
	await first.library.close();

	const second = await open({ root: first.root });

	expect(second.library.entries.map((item) => item.path)).toEqual([entry.path]);
	expect(second.library.entries[0]!.fields.audioPath).toBe(
		entry.fields.audioPath,
	);
	expect(second.library.resultsFor(entry.stem)[0]!.body).toBe(
		'a steady tone\n',
	);
	const audio = expectOk(
		await second.library.folder.files.open(entry.fields.audioPath!),
	);
	expect(new Uint8Array(await audio!.arrayBuffer())).toEqual(
		new Uint8Array(toneWav()),
	);
	expect(git(first.root, 'status', '--porcelain').trim()).toBe('');
});

test('deleting a recording removes its row and results, keeps its audio, and says so first', async () => {
	const { library, root } = await open();
	await record(library);
	const entry = library.entries[0]!;
	const audioPath = entry.fields.audioPath!;
	await library.transcribe(entry);

	const deletion = expectOk(await library.deletionFor(entry.path));
	// What the person is asked matches what the deletion does.
	const asked = describeDeletion(deletion, library.recordingNaming);
	expect(asked.description).toContain(
		`This deletes ${entry.path}, 1 transcription result from the folder.`,
	);
	expect(asked.description).toContain(`Its audio ${audioPath} is not deleted`);
	expect(await library.remove(deletion)).toBeUndefined();

	expect(library.entries).toHaveLength(0);
	expect(await readdir(join(root, 'transcriptions'))).toEqual([]);
	// The table removed its row file. The audio is an ordinary file and stays.
	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${entry.stem}.wav`,
	]);
	expect(new Uint8Array(await readFile(join(root, audioPath)))).toEqual(
		new Uint8Array(toneWav()),
	);

	// The audio is deleted as the file it is, from Files, with its own question.
	expect(library.recordingNaming(audioPath)).toBeUndefined();
	const file = expectOk(await library.deletionFor(audioPath));
	expect(file).toMatchObject({ kind: 'file', path: audioPath });
	expect(await library.remove(file!)).toBeUndefined();
	expect(await readdir(join(root, 'recordings'))).toEqual([]);
});

test('deleting the audio a recording names keeps the recording, and the missing file is reported', async () => {
	const { library, root } = await open();
	await record(library);
	const entry = library.entries[0]!;
	const audioPath = entry.fields.audioPath!;
	// Renaming it would leave the row naming a file that is gone.
	expect(await library.rename(audioPath, 'other.wav')).toContain(
		'names this audio file',
	);

	const deletion = expectOk(await library.deletionFor(audioPath));
	const asked = describeDeletion(deletion!, library.recordingNaming);
	expect(asked.description).toContain('names it as its audio and is kept');
	expect(await library.remove(deletion!)).toBeUndefined();

	expect(await readdir(join(root, 'recordings'))).toEqual([`${entry.stem}.md`]);
	expect(library.entries).toHaveLength(1);
	// The row still names the path; the missing file is reported, not hidden.
	expect(library.entries[0]!.fields.audioPath).toBe(audioPath);
	const { error: loadError } = await loadAudio(
		library.folder.files,
		audioPath,
		undefined,
	);
	expect(loadError?.name).toBe('NotFound');
});

test('a row written before audioPath names no audio: it needs repair, and no same-stem file is used', async () => {
	const { library, root, transcribed } = await open();
	await mkdir(join(root, 'recordings'), { recursive: true });
	// The earlier layout: no audioPath, with the audio beside the row.
	const old =
		'---\ntitle: Old take\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1000\ncapture: fixture\n---\nNotes\n';
	await writeFile(join(root, 'recordings', 'old.md'), old);
	await writeFile(join(root, 'recordings', 'old.wav'), toneWav());
	await library.refreshAll();

	const entry = library.entries.find((item) => item.stem === 'old')!;
	// The one field it lacks is the one issue; the others validated and are there.
	expect(entry.issues.map((issue) => issue.field)).toEqual(['audioPath']);
	expect<object>(entry.fields).toEqual({
		title: 'Old take',
		recordedAt: '2026-01-02T03:04:05.000Z',
		durationMs: 1000,
		capture: 'fixture',
	});
	// The file beside it is an ordinary file that no recording names.
	expect(library.recordingNaming('recordings/old.wav')).toBeUndefined();

	await library.transcribe(entry);

	expect(transcribed).toHaveLength(0);
	const run = library.transcriptionRun('old');
	expect(run?.kind).toBe('failed');
	if (run?.kind === 'failed') expect(run.message).toContain('names no audio');
	// Nothing was migrated or rewritten.
	expect(await readFile(join(root, 'recordings', 'old.md'), 'utf8')).toBe(old);

	// The person repairs it in Source by naming the audio: it opens as its text.
	await library.open('recordings/old.md');
	const editor = textOf(recordingSlot(library));
	expect(editor.buffer).toBe(old);
	editor.input(
		old.replace(
			'capture: fixture\n',
			'capture: fixture\naudioPath: recordings/old.wav\n',
		),
	);
	await editor.save();
	await library.refresh();
	const repaired = library.entries.find((item) => item.stem === 'old')!;
	expect(needsRepair(repaired)).toBe(false);
	expect(library.recordingNaming('recordings/old.wav')?.path).toBe(
		'recordings/old.md',
	);
	await library.transcribe(repaired);
	expect(transcribed.map((request) => request.audioPath)).toEqual([
		'recordings/old.wav',
	]);
});

test('a title edit changes frontmatter only: no file is renamed and the audio path stands', async () => {
	const { library, root } = await open();
	await record(library);
	const entry = library.entries[0]!;
	const editor = recordingEditor(library);
	const before = (await readdir(join(root, 'recordings'))).sort();

	editor.change({ fields: { title: 'A new title' } });
	await editor.saveNow();
	await library.refresh();

	expect((await readdir(join(root, 'recordings'))).sort()).toEqual(before);
	const saved = library.entries[0]!;
	expect(saved.path).toBe(entry.path);
	expect(saved.fields.title).toBe('A new title');
	expect(saved.fields.audioPath).toBe(entry.fields.audioPath);
});

test('a recording cannot be deleted while its transcription runs, including one started after confirming', async () => {
	let answer!: (value: Awaited<ReturnType<Workspace['transcribe']>>) => void;
	const { library, root } = await open({
		transcribe: () => new Promise((resolve) => (answer = resolve)),
	});
	await record(library);
	const entry = library.entries[0]!;
	// The person is asked, and agrees, before any request exists.
	const confirmed = expectOk(await library.deletionFor(entry.path));

	const transcribing = library.transcribe(entry);
	expect(library.transcriptionRun(entry.stem)?.kind).toBe('running');

	const { error: refusal } = await library.deletionFor(entry.path);
	expect(refusal).toContain('still running');
	expect(await library.remove(confirmed)).toContain('still running');
	expect(await readdir(join(root, 'recordings'))).toHaveLength(2);

	answer(Ok({ text: 'arrived late' }));
	await transcribing;

	// The transcript saved since was never named to the person, so they are asked again.
	expect(await library.remove(confirmed)).toContain('after you were asked');
	expect(await readdir(join(root, 'transcriptions'))).toHaveLength(1);
	const again = expectOk(await library.deletionFor(entry.path));
	expect(await library.remove(again!)).toBeUndefined();
	// The row is gone; the audio it named is not the table's to delete.
	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${entry.stem}.wav`,
	]);
	expect(await readdir(join(root, 'transcriptions'))).toEqual([]);
});

test('a recording cannot be deleted while a received transcript is unsaved; discarding it allows the deletion', async () => {
	const { library, root } = await open({ failResultWrites: 1 });
	await record(library);
	const entry = library.entries[0]!;
	await library.transcribe(entry);
	expect(library.transcriptionRun(entry.stem)?.kind).toBe('unsaved');

	const { error: refusal } = await library.deletionFor(entry.path);
	expect(refusal).toContain('Save it again or discard it');
	expect(await readdir(join(root, 'recordings'))).toHaveLength(2);
	const run = library.transcriptionRun(entry.stem);
	if (run?.kind !== 'unsaved') throw new Error('expected the transcript held');
	expect(run.text).toBe('a steady tone');

	library.dismissRun(entry.stem);
	const deletion = expectOk(await library.deletionFor(entry.path));
	expect(await library.remove(deletion!)).toBeUndefined();

	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${entry.stem}.wav`,
	]);
	expect(
		await readdir(join(root, 'transcriptions')).catch(() => [] as string[]),
	).toEqual([]);
});

/** The header's lines, from the same function AppHeader calls. */
function status(library: Library) {
	const files = filesLineOf(library);
	return {
		files,
		summary: summaryLine({
			files,
			uncommitted: uncommittedLine(library.git),
			commit: commitLine(library.git),
		}),
	};
}

test('audio replaced by bytes of the same length is noticed by its content', async () => {
	const { library, root } = await open();
	await record(library);
	const entry = library.entries[0]!;
	const path = entry.fields.audioPath!;
	const first = expectOk(
		await loadAudio(library.folder.files, path, undefined),
	);

	// Unchanged audio is the same object, so a player keeps what it has.
	const before = library.generation;
	await library.refreshAll();
	expect(library.generation).toBeGreaterThan(before);
	const again = expectOk(await loadAudio(library.folder.files, path, first));
	expect(again).toBe(first);

	const replaced = new Uint8Array(toneWav({ frequency: 880 }));
	expect(replaced.length).toBe(toneWav().length);
	await writeFile(join(root, path), replaced);
	// A refresh is what tells a mounted player to look again.
	const generation = library.generation;
	await library.refreshAll();
	expect(library.generation).toBeGreaterThan(generation);

	const next = expectOk(await loadAudio(library.folder.files, path, first));
	expect(next).not.toBe(first);
	expect(next!.blob.size).toBe(first.blob.size);
	expect(new Uint8Array(await next!.blob.arrayBuffer())).toEqual(replaced);
	expect(next!.blob.type).toBe('audio/wav');
});

test('a transcription transport that throws ends as a failure that can be retried', async () => {
	let attempts = 0;
	const { library } = await open({
		transcribe: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error('the folder host went away');
			return Ok({ text: 'second try' });
		},
	});
	await record(library);
	const entry = library.entries[0]!;

	await library.transcribe(entry);

	const failed = library.transcriptionRun(entry.stem);
	expect(failed?.kind).toBe('failed');
	if (failed?.kind === 'failed')
		expect(failed.message).toContain('the folder host went away');
	expect(library.resultsFor(entry.stem)).toHaveLength(0);

	await library.transcribe(entry);

	expect(attempts).toBe(2);
	expect(library.transcriptionRun(entry.stem)).toBeUndefined();
	expect(library.resultsFor(entry.stem)[0]!.body).toBe('second try\n');
});

test('a transcript whose file was not saved is reported as unsaved until it is', async () => {
	const { library, root } = await open({ failResultWrites: 1 });
	await record(library);
	await library.commit();
	await library.refreshAll();
	const entry = library.entries[0]!;
	expect(status(library).files.tone).toBe('good');

	await library.transcribe(entry);

	const run = library.transcriptionRun(entry.stem);
	expect(run?.kind).toBe('unsaved');
	if (run?.kind === 'unsaved') expect(run.text).toBe('a steady tone');
	expect(library.unsavedResults).toBe(1);
	expect(library.unsaved).toBe(true);
	expect(library.holdsUnsavedWork).toBe(true);
	const during = status(library);
	expect(during.files.tone).toBe('error');
	expect(during.files.label).toBe('1 transcription not saved');
	expect(during.summary.label).toBe('1 transcription not saved');
	expect(
		await readdir(join(root, 'transcriptions')).catch(() => [] as string[]),
	).toEqual([]);

	await library.retrySaveResult(entry.stem);

	expect(library.unsavedResults).toBe(0);
	expect(library.unsaved).toBe(false);
	expect(status(library).files.tone).toBe('good');
	expect(library.resultsFor(entry.stem)[0]!.body).toBe('a steady tone\n');
	expect(await readdir(join(root, 'transcriptions'))).toHaveLength(1);
});

/**
 * Count every write a recording's publication can make, and refuse the
 * reads that open its row for showing while `seen.refuse` is set.
 */
function watchPublication(library: Library) {
	const { files, tables } = library.folder;
	const table = tables.recordings;
	const { create: createFile } = files;
	const { create: createRow, edit } = table;
	const seen = { writes: 0, refuse: true };
	Object.assign(files, {
		create: (...args: Parameters<typeof createFile>) => {
			seen.writes += 1;
			return createFile(...args);
		},
	});
	Object.assign(table, {
		create: (...args: Parameters<typeof createRow>) => {
			seen.writes += 1;
			return createRow(...args);
		},
		edit: (...args: Parameters<typeof edit>) =>
			seen.refuse
				? Promise.resolve(
						FileError.Io({
							path: `recordings/${args[0]}.md`,
							operation: 'read',
							cause: new Error('read after publication failed'),
						}),
					)
				: edit(...args),
	});
	return seen;
}

test('a confirmed publication with a failed observation stays saved, and looking again never writes', async () => {
	const { library, root } = await open();
	const seen = watchPublication(library);
	await record(library);
	const pending = library.pending[0]!;
	expect(seen.writes).toBe(2);
	expect(pending.capture.bytes).toEqual(toneWav());
	expect(filesLineOf(library).label).not.toContain('not saved');
	expect(library.unsavedWork).toEqual([]);
	const path = join(root, 'recordings', `${pending.capture.id}.md`);
	const source = await readFile(path, 'utf8');
	await rm(path);
	seen.refuse = false;
	await library.retryPending(pending.capture.id);
	// Gone after it was saved: it is reported, and not written again.
	expect(library.pending[0]!.state).toMatchObject({
		kind: 'published',
		problem: 'missing',
	});
	expect(seen.writes).toBe(2);
	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${pending.capture.id}.wav`,
	]);
	expect(library.pending[0]!.capture.id).toBe(pending.capture.id);
	expect(library.pending[0]!.capture.bytes).toEqual(toneWav());
	await writeFile(path, source);
	await library.retryPending(pending.capture.id);
	expect(seen.writes).toBe(2);
	expect(library.pending).toHaveLength(0);
	expect(library.entries[0]!.stem).toBe(pending.capture.id);
});

/** Record once with the read that opens the row for showing refused, counting every write. */
async function publishedButUnshown() {
	const started = await open();
	const { library } = started;
	const seen = watchPublication(library);
	await record(library);
	return { ...started, seen, held: library.pending[0]! };
}

test('a confirmed publication is reported as saved with a separate observation problem, and holds nothing', async () => {
	const { library, root, seen, held, transcribed } =
		await publishedButUnshown();

	// The product state says what is true: both writes confirmed, and not shown.
	expect(held.state).toMatchObject({
		kind: 'published',
		problem: 'unreadable',
		checking: false,
		audio: { by: 'receipt', file: { path: held.capture.fields.audioPath } },
		row: { by: 'receipt', file: { path: `recordings/${held.capture.id}.md` } },
	});
	if (held.state.kind !== 'published') return;
	expect(held.state.message).toContain('read after publication failed');
	// Both files are in the folder, with the captured bytes.
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual([
		`${held.capture.id}.md`,
		`${held.capture.id}.wav`,
	]);
	expect(
		new Uint8Array(await readFile(join(root, held.capture.fields.audioPath))),
	).toEqual(new Uint8Array(toneWav()));

	// The status is a saved one, with the open question named beside it.
	const line = status(library);
	expect(line.files).toMatchObject({
		label: 'Saved · 1 recording to check',
		tone: 'warning',
	});
	expect(line.files.detail).toContain('nothing is written again');
	// The header's one line may show a running commit instead; it never says unsaved.
	expect(line.summary.label).not.toContain('not saved');
	// Nothing is only in the window, so nothing holds the app open.
	expect(library.unsaved).toBe(false);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(await library.prepareToLeave()).toBe(true);

	// Still unreadable: looking again changes nothing and writes nothing.
	await library.retryPending(held.capture.id);
	expect(seen.writes).toBe(2);
	expect(library.pending[0]!.state).toMatchObject({
		kind: 'published',
		problem: 'unreadable',
	});
	expect(library.pending[0]!.attempts).toBe(held.attempts);
	expect(library.pending[0]!.capture).toBe(held.capture);
	expect(transcribed).toEqual([]);

	// Readable again: the current row is what is shown and edited.
	seen.refuse = false;
	await library.retryPending(held.capture.id);
	expect(seen.writes).toBe(2);
	expect(library.pending).toHaveLength(0);
	expect(library.selectedPath).toBe(`recordings/${held.capture.id}.md`);
	expect(recordingEditor(library).state.baseline.source).toBe(
		await readFile(join(root, 'recordings', `${held.capture.id}.md`), 'utf8'),
	);
	expect(status(library).files.label).toBe('All changes saved to files');
	expect(transcribed).toEqual([]);
});

test('a published row that another writer replaced or edited is observed as it is, never repaired', async () => {
	const { library, root, seen, held } = await publishedButUnshown();
	const path = join(root, 'recordings', `${held.capture.id}.md`);
	const published = await readFile(path, 'utf8');
	seen.refuse = false;

	// Another program writes its own file over the row.
	const foreign = '---\ntitle: Someone else\n---\nKeep me\n';
	await writeFile(path, foreign);
	await library.retryPending(held.capture.id);

	expect(seen.writes).toBe(2);
	expect(library.pending[0]!.state).toMatchObject({
		kind: 'published',
		problem: 'foreign',
	});
	expect(library.pending[0]!.capture).toBe(held.capture);
	expect(await readFile(path, 'utf8')).toBe(foreign);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(status(library).files.label).toBe('Saved · 1 recording to check');

	// The person's own edit of the title and notes is still this recording.
	const edited = `${published.replace(/title: .*/, 'title: Renamed since')}Notes added since\n`;
	await writeFile(path, edited);
	await library.retryPending(held.capture.id);

	expect(seen.writes).toBe(2);
	expect(library.pending).toHaveLength(0);
	expect(await readFile(path, 'utf8')).toBe(edited);
	// The foreign text was opened as text; that draft followed the file and holds nothing.
	const editor = textOf(recordingSlot(library));
	expect(editor.baseline.source).toBe(edited);
	expect(editor.dirty).toBe(false);
	expect(library.entries[0]!.fields.title).toBe('Renamed since');
});

test('dismissing a published notice drops the window’s copy and changes nothing in the folder', async () => {
	const { library, root, seen, held } = await publishedButUnshown();
	const before = (await readdir(join(root, 'recordings'))).sort();

	library.discardPending(held.capture.id);

	expect(library.pending).toHaveLength(0);
	expect(seen.writes).toBe(2);
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual(before);
	expect(status(library).files.label).toBe('All changes saved to files');
});

test('a row write that failed after its audio landed is still unresolved: it is reported as not saved and holds the app open', async () => {
	const { library } = await open({ failRowWrites: 1 });
	await record(library);

	expect(library.pending[0]!.state.kind).toBe('rowNotSaved');
	expect(status(library).files).toMatchObject({
		label: '1 recording not saved',
		tone: 'error',
	});
	expect(library.unsavedWork).toEqual([
		'1 recording is not saved to the folder. Its audio is kept in this window. Any files already written stay in the folder.',
	]);
	expect(await library.prepareToLeave()).toBe(false);
});

test('an observation notice never hides another file’s unsaved typing', () => {
	const line = filesLine({
		saving: false,
		problems: 0,
		unsaved: true,
		pendingCaptures: 0,
		capturesSaving: false,
		publishedUnshown: 1,
		unsavedResults: 0,
		unsavedTransformations: 0,
	});
	expect(line.label).toBe('Unsaved typing');
});

/** Hold the next opening of a recording row for showing until `release`, then open it as it is. */
function holdOpening(library: Library) {
	const table = library.folder.tables.recordings;
	const { edit } = table;
	const held = Promise.withResolvers<void>();
	Object.assign(table, {
		edit: async (...args: Parameters<typeof edit>) => {
			await held.promise;
			return edit(...args);
		},
	});
	return held.resolve;
}

test('a late observation cannot restore a published notice that was dismissed', async () => {
	const { library, seen, held } = await publishedButUnshown();
	// The reads still fail: what answers late is a failure.
	const release = holdOpening(library);
	const refreshing = library.retryPending(held.capture.id);
	library.discardPending(held.capture.id);
	release();
	await refreshing;
	expect(library.pending).toHaveLength(0);
	expect(library.selectedPath).toBeUndefined();
	expect(seen.writes).toBe(2);
});

test('a late successful observation cannot select a dismissed recording', async () => {
	const { library, seen, held } = await publishedButUnshown();
	seen.refuse = false;
	const release = holdOpening(library);
	const refreshing = library.retryPending(held.capture.id);
	library.discardPending(held.capture.id);
	release();
	await refreshing;
	expect(library.pending).toHaveLength(0);
	expect(library.selectedPath).toBeUndefined();
	expect(seen.writes).toBe(2);
});

test('a late observation does not replace a file selected while it was reading', async () => {
	const { library, seen, held } = await publishedButUnshown();
	seen.refuse = false;
	const release = holdOpening(library);
	const refreshing = library.retryPending(held.capture.id);
	const created = await library.folder.files.create(
		'other.txt',
		'Another open file',
	);
	expectOk(created);
	await library.open('other.txt');
	expect(library.selectedPath).toBe('other.txt');
	release();
	await refreshing;
	expect(library.pending).toHaveLength(0);
	expect(library.selectedPath).toBe('other.txt');
	// The publication's two writes, and this test's own `other.txt`.
	expect(seen.writes).toBe(3);
});

// ============================================================================
// A received transcript and its one file
// ============================================================================

const transcripts = (root: string) =>
	readdir(join(root, 'transcriptions')).catch(() => [] as string[]);

/** The transcript held for a recording. */
function heldTranscript(library: Library, recording: string) {
	const run = library.transcriptionRun(recording);
	if (run?.kind !== 'unsaved')
		throw new Error(`Expected a held transcript, got ${run?.kind}`);
	return run;
}

/** Record and transcribe once, with the answer received and its row not confirmed. */
async function held(options: Options) {
	const opened = await open(options);
	await record(opened.library);
	const entry = opened.library.entries[0]!;
	await opened.library.transcribe(entry);
	return {
		...opened,
		entry,
		id: entry.stem,
		held: heldTranscript(opened.library, entry.stem),
	};
}

/**
 * Hold the next transcription row write until the test releases it. The write
 * then goes to the folder, or is refused before anything is written.
 */
function holdNextResultWrite(library: Library) {
	const table = library.folder.tables.transcriptions;
	const create = table.create;
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<'write' | 'refuse'>();
	Object.assign(table, {
		create: async (input: Parameters<typeof create>[0]) => {
			Object.assign(table, { create });
			started.resolve();
			return (await release.promise) === 'write'
				? create(input)
				: FileError.Io({
						path: `transcriptions/${input.stem}.md`,
						operation: 'create',
						cause: new Error('disk refused the result late'),
					});
		},
	});
	return { started: started.promise, release: release.resolve };
}

test('a transcript save that landed with its reply lost is recognized on saving again: one file, one request', async () => {
	const {
		library,
		root,
		transcribed,
		id,
		held: first,
	} = await held({ loseResultReplies: 1 });
	expect(await transcripts(root)).toHaveLength(1);
	// The write was not confirmed, and nothing claims that it wrote nothing.
	expect(first.message).toContain('may have completed');
	expect(library.holdsUnsavedWork).toBe(true);

	await library.retrySaveResult(id);

	expect(await transcripts(root)).toEqual([`${first.id}.md`]);
	expect(first).toMatchObject({
		text: 'a steady tone',
		body: 'a steady tone\n',
		saving: false,
	});
	expect(transcribed).toHaveLength(1);
	expect(library.transcriptionRun(id)).toBeUndefined();
	expect(library.unsaved).toBe(false);
	expect(library.holdsUnsavedWork).toBe(false);
	const results = library.resultsFor(id);
	expect(results.map((result) => result.stem)).toEqual([first.id]);
	expect(results[0]!.fields).toEqual(first.fields);
	expect(results[0]!.body).toBe(first.body);
});

test('two simultaneous saves of a held transcript write one file and leave nothing unsaved', async () => {
	const {
		library,
		root,
		transcribed,
		id,
		held: first,
	} = await held({ failResultWrites: 1 });
	expect(await transcripts(root)).toEqual([]);

	await Promise.all([library.retrySaveResult(id), library.retrySaveResult(id)]);

	expect(await transcripts(root)).toEqual([`${first.id}.md`]);
	expect(transcribed).toHaveLength(1);
	expect(library.transcriptionRun(id)).toBeUndefined();
	expect(library.unsavedResults).toBe(0);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(library.resultsFor(id).map((row) => row.body)).toEqual([
		'a steady tone\n',
	]);
});

test('another file at a held transcript’s path is left as it is, and the transcript stays held', async () => {
	const {
		library,
		root,
		transcribed,
		id,
		held: first,
	} = await held({ failResultWrites: 1 });
	const path = join(root, 'transcriptions', `${first.id}.md`);
	await mkdir(join(root, 'transcriptions'), { recursive: true });
	const squatter =
		'---\ntitle: not a transcript\n---\nSomeone else wrote this\n';
	await writeFile(path, squatter);

	await library.retrySaveResult(id);

	expect(await transcripts(root)).toEqual([`${first.id}.md`]);
	expect(await readFile(path, 'utf8')).toBe(squatter);
	const still = heldTranscript(library, id);
	expect(still).toMatchObject({
		id: first.id,
		fields: first.fields,
		text: 'a steady tone',
		saving: false,
	});
	expect(still.message).toContain('Nothing was overwritten');
	expect(library.holdsUnsavedWork).toBe(true);

	// The same fields with other text is another row too, not this transcript.
	await rm(path);
	const edited = await library.folder.tables.transcriptions.create({
		stem: first.id,
		fields: first.fields,
		body: 'a steady tone, edited since\n',
	});
	expectOk(edited);
	const theirs = await readFile(path, 'utf8');

	await library.retrySaveResult(id);

	expect(await readFile(path, 'utf8')).toBe(theirs);
	expect(heldTranscript(library, id).text).toBe('a steady tone');
	expect(transcribed).toHaveLength(1);
});

test('a held transcript refuses a new transcription request: the endpoint is not called and the text is kept', async () => {
	const {
		library,
		root,
		transcribed,
		entry,
		id,
		held: first,
	} = await held({ failResultWrites: 1 });

	await library.transcribe(entry);

	expect(transcribed).toHaveLength(1);
	expect(library.transcriptionRun(id)).toEqual(first);

	await library.retrySaveResult(id);

	expect(transcribed).toHaveLength(1);
	expect(await transcripts(root)).toEqual([`${first.id}.md`]);
	expect(library.resultsFor(id)[0]!.body).toBe('a steady tone\n');
});

test('a save that fails after its transcript was discarded does not bring the transcript back', async () => {
	const { library, root, id } = await held({ failResultWrites: 1 });
	const write = holdNextResultWrite(library);
	const saving = library.retrySaveResult(id);
	await write.started;
	expect(heldTranscript(library, id).saving).toBe(true);

	library.dismissRun(id);
	write.release('refuse');
	await saving;

	expect(library.transcriptionRun(id)).toBeUndefined();
	expect(library.unsavedResults).toBe(0);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(await transcripts(root)).toEqual([]);
});

test('a save that lands after its transcript was discarded leaves a newer held transcript as it is', async () => {
	let answers = 0;
	const {
		library,
		root,
		transcribed,
		failures,
		entry,
		id,
		held: first,
	} = await held({
		failResultWrites: 1,
		transcribe: async () => {
			answers += 1;
			return Ok({ text: answers === 1 ? 'first answer' : 'second answer' });
		},
	});
	const write = holdNextResultWrite(library);
	const saving = library.retrySaveResult(id);
	await write.started;
	library.dismissRun(id);
	// A new request is answered and its own write is refused: a newer transcript is held.
	failures.resultWrites = 1;
	await library.transcribe(entry);
	const second = heldTranscript(library, id);
	expect(second.text).toBe('second answer');
	expect(second.id).not.toBe(first.id);

	write.release('write');
	await saving;

	// The discarded transcript's write reached the folder, and its file stays there.
	expect(await transcripts(root)).toEqual([`${first.id}.md`]);
	expect(library.transcriptionRun(id)).toEqual(second);
	expect(library.unsavedResults).toBe(1);

	await library.retrySaveResult(id);

	expect(transcribed).toHaveLength(2);
	expect(library.transcriptionRun(id)).toBeUndefined();
	expect((await transcripts(root)).sort()).toEqual(
		[`${first.id}.md`, `${second.id}.md`].sort(),
	);
	expect(
		library
			.resultsFor(id)
			.map((row) => row.body)
			.sort(),
	).toEqual(['first answer\n', 'second answer\n']);
});

test('a transcript already in the folder is acknowledged as saved even when the folder cannot then be listed', async () => {
	const {
		library,
		root,
		transcribed,
		id,
		held: first,
	} = await held({ loseResultReplies: 1 });
	const table = library.folder.tables.transcriptions;
	const { get, list } = table;
	const unreadable = (operation: string) =>
		Promise.resolve(
			FileError.Io({
				path: 'transcriptions',
				operation,
				cause: new Error('the folder could not be read'),
			}),
		);

	// The row cannot be read, so nothing is known: the transcript stays held and nothing is written.
	Object.assign(table, { get: () => unreadable('read') });
	await library.retrySaveResult(id);
	const still = heldTranscript(library, id);
	expect(still).toMatchObject({
		id: first.id,
		text: 'a steady tone',
		saving: false,
	});
	expect(still.message).toContain('the folder could not be read');
	expect(await transcripts(root)).toEqual([`${first.id}.md`]);

	// The row reads as this transcript. The list read that follows fails on its own.
	Object.assign(table, { get, list: () => unreadable('list') });
	await library.retrySaveResult(id);
	expect(library.transcriptionRun(id)).toBeUndefined();
	expect(library.unsaved).toBe(false);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(status(library).files.label).not.toContain('not saved');
	expect(library.resultsFor(id)).toHaveLength(0);

	Object.assign(table, { list });
	await library.refresh();
	expect(library.resultsFor(id).map((result) => result.stem)).toEqual([
		first.id,
	]);
	expect(transcribed).toHaveLength(1);
	expect(await transcripts(root)).toEqual([`${first.id}.md`]);
});

test('while a held transcript is being written its recording cannot be deleted and the app stays held', async () => {
	const { library, root, entry, id } = await held({ failResultWrites: 1 });
	const write = holdNextResultWrite(library);
	const saving = library.retrySaveResult(id);
	await write.started;

	expect(heldTranscript(library, id).saving).toBe(true);
	const { error: heldRefusal } = await library.deletionFor(entry.path);
	expect(heldRefusal).toContain('Save it again or discard it');
	expect(library.unsavedWork).toEqual([
		'1 transcript arrived but its file is not saved.',
	]);
	expect(await library.prepareToLeave()).toBe(false);

	// Discarding drops the text. The write already begun is still on its way to the folder.
	library.dismissRun(id);
	expect(library.holdsUnsavedWork).toBe(false);
	const { error: writingRefusal } = await library.deletionFor(entry.path);
	expect(writingRefusal).toContain('still being written');
	expect(await readdir(join(root, 'recordings'))).toHaveLength(2);

	write.release('write');
	await saving;

	// The transcript that landed is named to the person before it is deleted.
	const deletion = expectOk(await library.deletionFor(entry.path));
	if (deletion?.kind !== 'recording')
		throw new Error('expected a recording deletion');
	expect(deletion.results).toHaveLength(1);
	expect(await library.remove(deletion)).toBeUndefined();
	expect(await transcripts(root)).toEqual([]);
});

test('the first write of a transcript keeps its run running: it cannot be dismissed or asked for again', async () => {
	const { library, root, transcribed } = await open();
	await record(library);
	const entry = library.entries[0]!;
	const id = entry.stem;
	const write = holdNextResultWrite(library);
	const transcribing = library.transcribe(entry);
	await write.started;

	expect(library.transcriptionRun(id)?.kind).toBe('running');
	library.dismissRun(id);
	await library.transcribe(entry);
	expect(library.transcriptionRun(id)?.kind).toBe('running');
	const { error: refusal } = await library.deletionFor(entry.path);
	expect(refusal).toContain('still running');
	expect(library.holdsUnsavedWork).toBe(true);

	write.release('refuse');
	await transcribing;

	// The answer is held with its file name fixed, and nothing was sent twice.
	const kept = heldTranscript(library, id);
	expect(kept.text).toBe('a steady tone');
	expect(transcribed).toHaveLength(1);
	await library.retrySaveResult(id);
	expect(await transcripts(root)).toEqual([`${kept.id}.md`]);
});

// ============================================================================
// A saved transcript and a deletion confirmed before it
// ============================================================================

/** Hold every listing of the transcriptions table until the test releases them. */
function holdResultLists(library: Library) {
	const table = library.folder.tables.transcriptions;
	const list = table.list;
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	Object.assign(table, {
		list: async () => {
			started.resolve();
			await released.promise;
			return list();
		},
	});
	return {
		started: started.promise,
		release() {
			Object.assign(table, { list });
			released.resolve();
		},
	};
}

test('a transcript saved after a deletion was confirmed refuses that deletion before any listing shows it', async () => {
	const { library, root } = await open();
	await record(library);
	const entry = library.entries[0]!;
	const id = entry.stem;
	// The person is asked, and agrees, while the recording has no results.
	const confirmed = expectOk(await library.deletionFor(entry.path));
	if (confirmed?.kind !== 'recording')
		throw new Error('expected a recording deletion');
	expect(confirmed.results).toEqual([]);
	const lists = holdResultLists(library);

	const transcribing = library.transcribe(entry);
	await lists.started;

	// The row is written and nothing is held; only the listing has not arrived.
	expect(library.transcriptionRun(id)).toBeUndefined();
	expect(library.unsaved).toBe(false);
	expect(library.resultsFor(id)).toEqual([]);
	const [name] = await transcripts(root);
	const saved = await readFile(join(root, 'transcriptions', name!), 'utf8');

	expect(await library.remove(confirmed)).toContain('after you were asked');

	expect((await readdir(join(root, 'recordings'))).sort()).toEqual([
		`${id}.md`,
		`${id}.wav`,
	]);
	expect(await transcripts(root)).toEqual([name!]);
	expect(await readFile(join(root, 'transcriptions', name!), 'utf8')).toBe(
		saved,
	);

	lists.release();
	await transcribing;

	// Asked again, the person is told about the transcript, and it goes with the recording.
	const again = expectOk(await library.deletionFor(entry.path));
	if (again?.kind !== 'recording')
		throw new Error('expected a recording deletion');
	expect(again.results.map((result) => result.path)).toEqual([
		`transcriptions/${name}`,
	]);
	expect(await library.remove(again)).toBeUndefined();
	expect(await transcripts(root)).toEqual([]);
	expect(await readdir(join(root, 'recordings'))).toEqual([`${id}.wav`]);
	expect(
		new Uint8Array(await readFile(join(root, 'recordings', `${id}.wav`))),
	).toEqual(new Uint8Array(toneWav()));
});

test('a transcript saved when the listing after it fails stays saved, and still refuses an earlier deletion', async () => {
	const { library, root, transcribed } = await open();
	await record(library);
	const entry = library.entries[0]!;
	const id = entry.stem;
	const confirmed = expectOk(await library.deletionFor(entry.path));
	if (confirmed?.kind !== 'recording')
		throw new Error('expected a recording deletion');
	const table = library.folder.tables.transcriptions;
	const list = table.list;
	Object.assign(table, {
		list: async () =>
			FileError.Io({
				path: 'transcriptions',
				operation: 'list',
				cause: new Error('the folder could not be listed'),
			}),
	});

	await library.transcribe(entry);

	// Saved: nothing is held, nothing is offered again, and the view claims nothing it did not read.
	expect(library.transcriptionRun(id)).toBeUndefined();
	expect(library.unsaved).toBe(false);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(library.resultsFor(id)).toEqual([]);
	const [name] = await transcripts(root);
	await library.retrySaveResult(id);
	expect(transcribed).toHaveLength(1);
	expect(await transcripts(root)).toEqual([name!]);

	expect(await library.remove(confirmed)).toContain('after you were asked');
	expect(await readdir(join(root, 'recordings'))).toHaveLength(2);
	expect(await transcripts(root)).toEqual([name!]);

	// A new confirmation names the transcript from its publication, with the listing still failing.
	const again = expectOk(await library.deletionFor(entry.path));
	if (again?.kind !== 'recording')
		throw new Error('expected a recording deletion');
	expect(again.results.map((result) => result.path)).toEqual([
		`transcriptions/${name}`,
	]);
	expect(await library.remove(again)).toBeUndefined();
	expect(await transcripts(root)).toEqual([]);
	expect(await readdir(join(root, 'recordings'))).toEqual([`${id}.wav`]);

	Object.assign(table, { list });
	await library.refresh();
	expect(library.entries).toEqual([]);
	expect(library.resultsFor(id)).toEqual([]);
});

// ============================================================================
// A text file whose save reply was lost
// ============================================================================

test('a text file whose save reply was lost holds the close, and a refresh, preparing to leave, and closing write nothing more', async () => {
	const { library, root } = await open();
	await writeFile(join(root, 'notes.md'), 'original\n');
	await library.refreshAll();
	await library.open('notes.md');
	const selection = library.selection;
	if (selection?.kind !== 'file' || selection.file.kind !== 'text')
		throw new Error('expected notes.md open as text');
	const { editor } = selection.file;
	const { files } = library.folder;
	const replace = files.replace;
	const sent: string[] = [];
	Object.assign(files, {
		async replace(...args: Parameters<typeof replace>) {
			const [file, content] = args;
			sent.push(new TextDecoder().decode(content as Uint8Array));
			const written = await replace(...args);
			const { error: replaceError } = written;
			return replaceError !== null
				? written
				: FileError.Unconfirmed({
						path: file.path,
						operation: 'replace',
						cause: 'reply lost after the write',
					});
		},
	});

	editor.input('typed\n');
	expect(await editor.settle()).toBe(false);
	expect(editor.saveState.kind).toBe('unconfirmed');
	expect(library.unsavedWork).toEqual([
		'notes.md has edits whose last save was not confirmed.',
	]);
	expect(library.saveProblems).toBe(1);

	// Typing after it, and a refresh that finds the file holding the lost save.
	editor.input('typed, then more\n');
	await library.refreshAll();
	expect(editor.saveState).toMatchObject({
		kind: 'conflict',
		current: { source: 'typed\n' },
	});
	expect(editor.unknown).toContain('reply lost');
	expect(library.unsavedWork).toEqual([
		'notes.md has edits held in a conflict.',
	]);
	expect(await library.prepareToLeave()).toBe(false);

	opened.splice(opened.indexOf(library), 1);
	await library.close();
	expect(sent).toEqual(['typed\n']);
	expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('typed\n');
});

test('a rename where the destination landed and the source could not be removed says both files are there', async () => {
	const { library, root } = await open();
	await writeFile(join(root, 'notes.md'), 'original\n');
	await library.refreshAll();
	const { files } = library.folder;
	const move = files.move;
	Object.assign(files, {
		async move(...args: Parameters<typeof move>) {
			const [file, destination] = args;
			const copied = expectOk(await files.read(file.path));
			const written = expectOk(await files.create(destination, copied.bytes));
			const { error: removeFailure } = FileError.Io({
				path: file.path,
				operation: 'remove',
				cause: new Error('permission denied'),
			});
			return MoveError.SourceNotRemoved({
				from: file.path,
				to: destination,
				moved: written,
				cause: removeFailure,
			});
		},
	});

	const problem = await library.rename('notes.md', 'renamed.md');

	expect(problem).toBe(
		'"renamed.md" was written, but "notes.md" could not be removed, so both are in the folder now: ' +
			"Could not remove 'notes.md': permission denied",
	);
	expect(
		(await readdir(root)).filter((name) => name.endsWith('.md')).sort(),
	).toEqual(['notes.md', 'renamed.md']);
	// No draft was open, so there are no edits to hold.
	expect(library.unresolvedMoves).toEqual([]);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('a rename that left the file at both paths holds the open draft’s typing until the person keeps it at one of them', async () => {
	const { library, root } = await open();
	await writeFile(join(root, 'notes.md'), 'original\n');
	await library.refreshAll();
	await library.open('notes.md');
	const selection = library.selection;
	if (selection?.kind !== 'file' || selection.file.kind !== 'text')
		throw new Error('expected notes.md open as text');
	const { editor } = selection.file;
	const { files } = library.folder;
	const move = files.move;
	Object.assign(files, {
		async move(...args: Parameters<typeof move>) {
			const [file, destination] = args;
			// The person types while the file is copied.
			editor.input('typed during the move\n');
			const copied = expectOk(await files.read(file.path));
			const written = expectOk(await files.create(destination, copied.bytes));
			const { error: removeFailure } = FileError.Io({
				path: file.path,
				operation: 'remove',
				cause: new Error('permission denied'),
			});
			return MoveError.SourceNotRemoved({
				from: file.path,
				to: destination,
				moved: written,
				cause: removeFailure,
			});
		},
	});

	expect(await library.rename('notes.md', 'renamed.md')).toContain(
		'both are in the folder now',
	);
	await Bun.sleep(600);
	await library.refreshAll();

	// Both paths hold the file as it was; the typing waits for the person.
	expect(library.unresolvedMoves).toEqual([
		expect.objectContaining({
			from: 'notes.md',
			to: 'renamed.md',
			found: { from: 'matches', to: 'matches' },
		}),
	]);
	expect(editor.buffer).toBe('typed during the move\n');
	expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('original\n');
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe('original\n');
	expect(await library.prepareToLeave()).toBe(false);

	expect(
		await library.resolveMove('notes.md', 'keepAtDestination'),
	).toBeUndefined();
	const moved = library.selection;
	if (moved?.kind !== 'file' || moved.file.kind !== 'text')
		throw new Error('expected renamed.md open as text');
	expect(moved.path).toBe('renamed.md');
	expect(await moved.file.editor.settle()).toBe(true);
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe(
		'typed during the move\n',
	);
	expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('original\n');
	expect(library.holdsUnsavedWork).toBe(false);
});

// ============================================================================
// A file that moves or is deleted while its draft is open
// ============================================================================

/** Hold the next call to `method` on `target` until `release`; `reached` when it is made. */
function holdNext<TTarget extends object>(
	target: TTarget,
	method: keyof TTarget & string,
) {
	const real = target[method] as (...args: unknown[]) => Promise<unknown>;
	const reached = Promise.withResolvers<void>();
	const held = Promise.withResolvers<void>();
	Object.assign(target, {
		[method]: async (...args: unknown[]) => {
			Object.assign(target, { [method]: real });
			reached.resolve();
			await held.promise;
			return real(...args);
		},
	});
	return { reached: reached.promise, release: () => held.resolve() };
}

/** A recording with one transcript open in its draft. */
async function openTranscript(library: Library) {
	await record(library);
	await library.transcribe(library.entries[0]!);
	const transcript = library.resultsFor(library.entries[0]!.stem)[0]!;
	await library.openTranscript(transcript.path);
	return { transcript, draft: formOf(library.transcriptAt(transcript.path)) };
}

test('typing taken while a transcript moves follows it to its new name, and nothing is written at the old one', async () => {
	const { library, root } = await open();
	const { transcript, draft } = await openTranscript(library);
	draft.change({ body: 'Typed before the rename.\n' });
	const move = holdNext(library.folder.files, 'move');

	const renaming = library.rename(transcript.path, 'renamed.md');
	await move.reached;
	// The draft was settled before the move.
	expect(await readFile(join(root, transcript.path), 'utf8')).toContain(
		'Typed before the rename.',
	);
	expect(draft.change({ body: 'Typed while it moved.\n' })).toBe(true);
	await Bun.sleep(600);
	// Nothing is written at the old path while the file moves.
	expect(await readFile(join(root, transcript.path), 'utf8')).toContain(
		'Typed before the rename.',
	);
	move.release();
	expect(await renaming).toBeUndefined();

	const to = 'transcriptions/renamed.md';
	expect(await Bun.file(join(root, transcript.path)).exists()).toBe(false);
	expect(draft.state.isDisposed).toBe(true);
	const moved = formOf(library.transcriptAt(to));
	expect(moved.state.document.body).toBe('Typed while it moved.\n');
	expect(moved.isDirty).toBe(true);
	expect(await moved.settle()).toBe(true);
	expect(await readFile(join(root, to), 'utf8')).toContain(
		'Typed while it moved.',
	);
	expect(await Bun.file(join(root, transcript.path)).exists()).toBe(false);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('a move the folder refuses leaves the draft at its file, and the typing taken meanwhile saves there', async () => {
	const { library, root } = await open();
	const { transcript, draft } = await openTranscript(library);
	await writeFile(join(root, 'transcriptions', 'taken.md'), 'Someone else\n');
	const move = holdNext(library.folder.files, 'move');

	const renaming = library.rename(transcript.path, 'taken.md');
	await move.reached;
	expect(draft.change({ body: 'Typed while it did not move.\n' })).toBe(true);
	move.release();
	expect(await renaming).toContain('already exists');

	expect(await draft.settle()).toBe(true);
	expect(await readFile(join(root, transcript.path), 'utf8')).toContain(
		'Typed while it did not move.',
	);
	expect(await readFile(join(root, 'transcriptions', 'taken.md'), 'utf8')).toBe(
		'Someone else\n',
	);
});

// The page is asked to close while a rename is held: admission stops, and the
// close waits for the rename it had already accepted.

const TYPED = 'Typed while it moved.\n';

/** Rename with the move held, type, then pause admission and start preparing to leave. */
async function renameWhileClosing(
	library: Library,
	from: string,
	name: string,
	type: () => boolean,
	move = holdNext(library.folder.files, 'move'),
) {
	const renaming = library.rename(from, name);
	await move.reached;
	expect(type()).toBe(true);
	library.pauseAdmission();
	const leaving = library.prepareToLeave();
	move.release();
	return { said: await renaming, leaving: await leaving };
}

test('a transcript renamed while the page decides to close carries its typing to the new name, and the close waits for its save', async () => {
	const { library, root } = await open();
	const { transcript, draft } = await openTranscript(library);

	const { said, leaving } = await renameWhileClosing(
		library,
		transcript.path,
		'renamed.md',
		() => draft.change({ body: TYPED }),
	);

	expect(said).toBeUndefined();
	expect(leaving).toBe(true);
	expect(
		await readFile(join(root, 'transcriptions', 'renamed.md'), 'utf8'),
	).toContain(TYPED);
	expect(await Bun.file(join(root, transcript.path)).exists()).toBe(false);
	expect(library.unsavedWork).toEqual([]);
});

test('with autosave paused, a transcript renamed while the page decides to close keeps its typing and the close asks', async () => {
	const { library, root } = await open();
	const { transcript, draft } = await openTranscript(library);
	library.autosave.paused = true;

	const { said, leaving } = await renameWhileClosing(
		library,
		transcript.path,
		'renamed.md',
		() => draft.change({ body: TYPED }),
	);

	const to = 'transcriptions/renamed.md';
	expect(said).toBeUndefined();
	expect(leaving).toBe(false);
	expect(library.unsavedWork).toEqual([`${to} has unsaved edits.`]);
	expect(formOf(library.transcriptAt(to)).state.document.body).toBe(TYPED);
	expect(await readFile(join(root, to), 'utf8')).not.toContain(TYPED);
});

test('a text file renamed while the page decides to close carries its typing to the new name', async () => {
	const { library, root } = await open();
	await writeFile(join(root, 'notes.md'), 'original\n');
	await library.refreshAll();
	await library.open('notes.md');
	const selection = library.selection;
	if (selection?.kind !== 'file' || selection.file.kind !== 'text')
		throw new Error('expected notes.md open as text');
	const { editor } = selection.file;

	const { said, leaving } = await renameWhileClosing(
		library,
		'notes.md',
		'renamed.md',
		() => {
			editor.input(TYPED);
			return editor.buffer === TYPED;
		},
	);

	expect(said).toBeUndefined();
	expect(leaving).toBe(true);
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe(TYPED);
	expect(await Bun.file(join(root, 'notes.md')).exists()).toBe(false);
});

test('a rename refused while the page decides to close leaves the typing at the file, and the close waits for its save', async () => {
	const { library, root } = await open();
	const { transcript, draft } = await openTranscript(library);
	await writeFile(join(root, 'transcriptions', 'taken.md'), 'Someone else\n');

	const { said, leaving } = await renameWhileClosing(
		library,
		transcript.path,
		'taken.md',
		() => draft.change({ body: TYPED }),
	);

	expect(said).toContain('already exists');
	expect(leaving).toBe(true);
	expect(await readFile(join(root, transcript.path), 'utf8')).toContain(TYPED);
	expect(await readFile(join(root, 'transcriptions', 'taken.md'), 'utf8')).toBe(
		'Someone else\n',
	);
});

test('a rename whose reply is lost while the page decides to close holds the typing, and the close asks', async () => {
	const { library, root } = await open();
	const { transcript, draft } = await openTranscript(library);
	const { files } = library.folder;
	const move = files.move;
	const reached = Promise.withResolvers<void>();
	const held = Promise.withResolvers<void>();
	Object.assign(files, {
		async move(...args: Parameters<typeof move>) {
			reached.resolve();
			await held.promise;
			// It moves; the reply is lost.
			const moved = await move(...args);
			const { error: moveError } = moved;
			return moveError !== null
				? moved
				: FileError.Unconfirmed({
						path: args[0].path,
						operation: 'move',
						cause: 'reply lost after the move',
					});
		},
	});
	const before = await readFile(join(root, transcript.path), 'utf8');

	const { said, leaving } = await renameWhileClosing(
		library,
		transcript.path,
		'renamed.md',
		() => draft.change({ body: TYPED }),
		{ reached: reached.promise, release: () => held.resolve() },
	);

	expect(said).toContain('did not confirm the rename');
	expect(leaving).toBe(false);
	expect(library.unsavedWork[0]).toContain('did not end as asked');
	expect(draft.state.document.body).toBe(TYPED);
	await Bun.sleep(600);
	expect(
		await readFile(join(root, 'transcriptions', 'renamed.md'), 'utf8'),
	).toBe(before);
	expect(await Bun.file(join(root, transcript.path)).exists()).toBe(false);
});

// Edits never move onto a draft that already holds someone's edits.

/** The folder's move, held until `release`, landing and then losing its reply. */
function lostReplyMove(library: Library) {
	const { files } = library.folder;
	const move = files.move;
	const reached = Promise.withResolvers<void>();
	const held = Promise.withResolvers<void>();
	Object.assign(files, {
		async move(...args: Parameters<typeof move>) {
			Object.assign(files, { move });
			reached.resolve();
			await held.promise;
			const moved = await move(...args);
			const { error: moveError } = moved;
			return moveError !== null
				? moved
				: FileError.Unconfirmed({
						path: args[0].path,
						operation: 'move',
						cause: 'reply lost after the move',
					});
		},
	});
	return { reached: reached.promise, release: () => held.resolve() };
}

/** The text draft Files keeps for `path`, opened now. */
async function textDraft(library: Library, path: string) {
	await library.open(path);
	const selection = library.selection;
	if (selection?.kind !== 'file' || selection.file.kind !== 'text')
		throw new Error(`expected ${path} open as text`);
	return selection.file.editor;
}

test('keeping held edits at a transcript whose own draft has typing is refused, and both drafts are kept with nothing written', async () => {
	const { library, root } = await open();
	const { transcript, draft } = await openTranscript(library);
	library.autosave.paused = true;
	const to = 'transcriptions/two.md';
	const move = lostReplyMove(library);
	const renaming = library.rename(transcript.path, 'two.md');
	await move.reached;
	draft.change({ body: TYPED });
	move.release();
	expect(await renaming).toContain('did not confirm the rename');

	await library.open(to);
	const destination = formOf(library.transcriptAt(to));
	expect(destination.change({ body: 'Typed at the destination.\n' })).toBe(
		true,
	);
	const before = await readFile(join(root, to), 'utf8');

	expect(
		await library.resolveMove(transcript.path, 'keepAtDestination'),
	).toContain('edits of its own');

	expect(destination.state.document.body).toBe('Typed at the destination.\n');
	expect(draft.state.isDisposed).toBe(false);
	expect(draft.state.document.body).toBe(TYPED);
	expect(library.unresolvedMoves).toHaveLength(1);
	expect(library.unsavedWork).toEqual([
		expect.stringContaining('did not end as asked'),
		`${to} has unsaved edits.`,
	]);
	await Bun.sleep(600);
	expect(await readFile(join(root, to), 'utf8')).toBe(before);
	expect(await Bun.file(join(root, transcript.path)).exists()).toBe(false);

	// Saving the held edits as a copy still works, and leaves the destination's typing alone.
	const copy = expectOk(await library.copyHeldEdits(transcript.path));
	expect(await readFile(join(root, copy), 'utf8')).toContain(TYPED);
	expect(destination.state.document.body).toBe('Typed at the destination.\n');
	expect(library.unresolvedMoves).toEqual([]);
	expect(await readFile(join(root, to), 'utf8')).toBe(before);
});

test('keeping held edits at a text file whose own draft has typing is refused, and both drafts are kept with nothing written', async () => {
	const { library, root } = await open();
	await writeFile(join(root, 'notes.md'), 'original\n');
	await library.refreshAll();
	const source = await textDraft(library, 'notes.md');
	library.autosave.paused = true;
	const move = lostReplyMove(library);
	const renaming = library.rename('notes.md', 'renamed.md');
	await move.reached;
	source.input(TYPED);
	move.release();
	expect(await renaming).toContain('did not confirm the rename');

	const destination = await textDraft(library, 'renamed.md');
	destination.input('Typed at the destination.\n');

	expect(await library.resolveMove('notes.md', 'keepAtDestination')).toContain(
		'edits of its own',
	);

	expect(destination.buffer).toBe('Typed at the destination.\n');
	expect(source.buffer).toBe(TYPED);
	expect(library.unresolvedMoves).toHaveLength(1);
	await Bun.sleep(600);
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe('original\n');
	expect(await Bun.file(join(root, 'notes.md')).exists()).toBe(false);
	// Discarding the held edits leaves the destination's typing as it is.
	expect(await library.resolveMove('notes.md', 'discard')).toBeUndefined();
	expect(destination.buffer).toBe('Typed at the destination.\n');
	expect(library.unsavedWork).toEqual(['renamed.md has unsaved edits.']);
});

test('a rename onto a name whose draft still holds edits is refused before anything moves', async () => {
	const { library, root } = await open();
	await writeFile(join(root, 'notes.md'), 'original\n');
	await writeFile(join(root, 'renamed.md'), 'the old renamed\n');
	await library.refreshAll();
	library.autosave.paused = true;
	const stale = await textDraft(library, 'renamed.md');
	stale.input('Typed into renamed.\n');
	// Another program removes the file under that typing.
	await rm(join(root, 'renamed.md'));
	await library.refreshAll();
	await textDraft(library, 'notes.md');

	expect(await library.rename('notes.md', 'renamed.md')).toContain(
		'Nothing was renamed',
	);

	expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('original\n');
	expect(await Bun.file(join(root, 'renamed.md')).exists()).toBe(false);
	expect(stale.buffer).toBe('Typed into renamed.\n');
	expect(library.unresolvedMoves).toEqual([]);
});

test('typing into the new name’s draft while the file moves keeps both: the moved edits are held at the old name until the person chooses', async () => {
	const { library, root } = await open();
	await writeFile(join(root, 'notes.md'), 'original\n');
	await writeFile(join(root, 'renamed.md'), 'the old renamed\n');
	await library.refreshAll();
	library.autosave.paused = true;
	const destination = await textDraft(library, 'renamed.md');
	// Another program removes it; no refresh has noticed yet, so its draft holds nothing.
	await rm(join(root, 'renamed.md'));
	const source = await textDraft(library, 'notes.md');
	const move = holdNext(library.folder.files, 'move');

	const renaming = library.rename('notes.md', 'renamed.md');
	await move.reached;
	source.input(TYPED);
	destination.input('Typed at the destination while it moved.\n');
	move.release();
	const said = await renaming;

	expect(said).toContain('was renamed to "renamed.md"');
	expect(said).toContain('edits of its own');
	expect(source.buffer).toBe(TYPED);
	expect(destination.buffer).toBe('Typed at the destination while it moved.\n');
	expect(library.unresolvedMoves).toEqual([
		expect.objectContaining({
			from: 'notes.md',
			to: 'renamed.md',
			found: { from: 'missing', to: 'matches' },
		}),
	]);
	await Bun.sleep(600);
	await library.refreshAll();
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe('original\n');
	expect(await Bun.file(join(root, 'notes.md')).exists()).toBe(false);
	expect(source.buffer).toBe(TYPED);
	expect(await library.prepareToLeave()).toBe(false);

	// The held edits can still be saved as a copy; the destination's typing stays.
	const copy = expectOk(await library.copyHeldEdits('notes.md'));
	expect(await readFile(join(root, copy), 'utf8')).toBe(TYPED);
	expect(destination.buffer).toBe('Typed at the destination while it moved.\n');
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe('original\n');
});

// Edits move only onto the file as it was: another program may write the
// new name while its draft is being opened.

test('keeping held edits at a transcript another program rewrote while its draft opened is refused, and its file is left as written', async () => {
	const { library, root } = await open();
	const { transcript, draft } = await openTranscript(library);
	library.autosave.paused = true;
	const to = 'transcriptions/two.md';
	const move = lostReplyMove(library);
	const renaming = library.rename(transcript.path, 'two.md');
	await move.reached;
	draft.change({ body: TYPED });
	move.release();
	expect(await renaming).toContain('did not confirm the rename');
	const original = await readFile(join(root, to), 'utf8');
	const foreign = original.replace(/model: .*/, 'model: someone-else');
	// The draft at the new name opens after another program rewrote it.
	const table = library.folder.tables.transcriptions;
	const edit = table.edit;
	Object.assign(table, {
		async edit(...args: Parameters<typeof edit>) {
			Object.assign(table, { edit });
			await writeFile(join(root, to), foreign);
			return edit(...args);
		},
	});

	expect(
		await library.resolveMove(transcript.path, 'keepAtDestination'),
	).toContain('no longer holds the file as it was');

	const destination = formOf(library.transcriptAt(to));
	expect(destination.isDirty).toBe(false);
	expect(destination.state.document.fields.model).toBe('someone-else');
	expect(draft.state.isDisposed).toBe(false);
	expect(draft.state.document.body).toBe(TYPED);
	expect(library.unresolvedMoves).toEqual([
		expect.objectContaining({
			from: transcript.path,
			found: { from: 'missing', to: 'different' },
		}),
	]);
	await Bun.sleep(600);
	await library.refreshAll();
	expect(await readFile(join(root, to), 'utf8')).toBe(foreign);
	expect(await Bun.file(join(root, transcript.path)).exists()).toBe(false);
	expect(await library.prepareToLeave()).toBe(false);

	// The held edits still leave as a copy; the rewritten file stays as written.
	const copy = expectOk(await library.copyHeldEdits(transcript.path));
	expect(await readFile(join(root, copy), 'utf8')).toContain(TYPED);
	expect(await readFile(join(root, to), 'utf8')).toBe(foreign);
	expect(library.unresolvedMoves).toEqual([]);
});

test('a file another program rewrites at the new name while a rename opens it there keeps the moved edits held at the old name', async () => {
	const { library, root } = await open();
	await writeFile(join(root, 'notes.md'), 'original\n');
	await library.refreshAll();
	const source = await textDraft(library, 'notes.md');
	library.autosave.paused = true;
	const move = holdNext(library.folder.files, 'move');
	// The new name's draft reads it after another program rewrote it.
	const { files } = library.folder;
	const read = files.read;
	Object.assign(files, {
		async read(...args: Parameters<typeof read>) {
			if (args[0] === 'renamed.md') {
				Object.assign(files, { read });
				await writeFile(join(root, 'renamed.md'), 'Someone else\n');
			}
			return read(...args);
		},
	});

	const renaming = library.rename('notes.md', 'renamed.md');
	await move.reached;
	source.input(TYPED);
	move.release();
	const said = await renaming;

	expect(said).toContain('was renamed to "renamed.md"');
	expect(said).toContain('no longer holds the file as it was');
	expect(source.buffer).toBe(TYPED);
	const destination = await textDraft(library, 'renamed.md');
	expect(destination.buffer).toBe('Someone else\n');
	expect(destination.dirty).toBe(false);
	expect(library.unresolvedMoves).toEqual([
		expect.objectContaining({
			from: 'notes.md',
			to: 'renamed.md',
			found: { from: 'missing', to: 'different' },
		}),
	]);
	await Bun.sleep(600);
	await library.refreshAll();
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe(
		'Someone else\n',
	);
	expect(await Bun.file(join(root, 'notes.md')).exists()).toBe(false);
	expect(await library.resolveMove('notes.md', 'keepAtDestination')).toContain(
		'does not hold the file as it was',
	);

	// Discarding the held edits is the way out; the rewritten file stays as written.
	expect(await library.resolveMove('notes.md', 'discard')).toBeUndefined();
	expect(library.unresolvedMoves).toEqual([]);
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe(
		'Someone else\n',
	);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('a recording being deleted takes no typing, and nothing writes its row again', async () => {
	const { library, root } = await open();
	await record(library);
	const editor = recordingEditor(library);
	const path = join(root, editor.path);
	const deletion = expectOk(await library.deletionFor(editor.path));
	const removal = holdNext(library.folder.tables.recordings, 'delete');

	const removing = library.remove(deletion);
	await removal.reached;
	expect(editor.change({ fields: { title: 'Typed while deleted' } })).toBe(
		false,
	);
	await editor.saveNow();
	removal.release();
	expect(await removing).toBeUndefined();
	await Bun.sleep(600);

	expect(await Bun.file(path).exists()).toBe(false);
	expect(editor.state.isDisposed).toBe(true);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('a deletion the folder refuses leaves the draft as it was, taking typing and saving again', async () => {
	const { library, root } = await open();
	await record(library);
	const editor = recordingEditor(library);
	const path = join(root, editor.path);
	const deletion = expectOk(await library.deletionFor(editor.path));
	// Another program changes the row after the person was asked.
	const outside = (await readFile(path, 'utf8')).replace(
		/title: .*/,
		'title: Changed outside',
	);
	await writeFile(path, outside);

	expect(await library.remove(deletion)).toContain('different content');

	expect(await readFile(path, 'utf8')).toBe(outside);
	await library.refreshAll();
	expect(editor.change({ body: 'Typed after the refusal.\n' })).toBe(true);
	expect(await editor.settle()).toBe(true);
	expect(await readFile(path, 'utf8')).toContain('Typed after the refusal.');
});

test('a recording is not deleted while a draft of one of its results holds typing or a save whose reply was lost', async () => {
	const { library, root } = await open();
	const { transcript, draft } = await openTranscript(library);
	const recording = library.entries[0]!;
	expect(
		await library.createTransformation({ title: 'Echo', prompt: 'Repeat.\n' }),
	).toBeUndefined();
	expect(
		await library.transform(
			transcript.path,
			library.selectedTransformationPath!,
		),
	).toBeUndefined();
	const output = library.transformationResults[0]!;
	const kept = async () => {
		for (const path of [recording.path, transcript.path, output.path])
			expect(await Bun.file(join(root, path)).exists()).toBe(true);
		expect(library.entries.map((entry) => entry.path)).toEqual([
			recording.path,
		]);
	};

	// Typing in the transcript's draft since the person was asked.
	let deletion = expectOk(await library.deletionFor(recording.path));
	expect(draft.change({ body: 'Typed after confirming.\n' })).toBe(true);
	expect(await library.remove(deletion)).toContain('Save or discard');
	await kept();
	expect(await draft.settle()).toBe(true);

	// Typing in the transformation result, opened in Files as text.
	const outputDraft = await textDraft(library, output.path);
	deletion = expectOk(await library.deletionFor(recording.path));
	outputDraft.input(`${outputDraft.buffer}Typed into the result.\n`);
	expect(await library.remove(deletion)).toContain('Save or discard');
	await kept();
	expect(await outputDraft.settle()).toBe(true);

	// A save of the transcript whose reply was lost, and a read that finds
	// the file holding its text: the save is still not known to have landed.
	expect(await library.editSource(transcript.path)).toBeUndefined();
	const source = textOf(library.transcriptAt(transcript.path));
	const { files } = library.folder;
	const replace = files.replace;
	Object.assign(files, {
		async replace(...args: Parameters<typeof replace>) {
			Object.assign(files, { replace });
			const written = await replace(...args);
			const { error: replaceError } = written;
			return replaceError !== null
				? written
				: FileError.Unconfirmed({
						path: args[0].path,
						operation: 'replace',
						cause: 'reply lost after the write',
					});
		},
	});
	source.input(`${source.buffer}Saved, reply lost.\n`);
	expect(await source.settle()).toBe(false);
	await library.refreshAll();
	expect(await readFile(join(root, transcript.path), 'utf8')).toContain(
		'Saved, reply lost.',
	);
	deletion = expectOk(await library.deletionFor(recording.path));
	expect(await library.remove(deletion)).toContain('Save or discard');
	await kept();
});

test('a recording’s results take no typing while it is deleted, and nothing writes them again', async () => {
	const { library, root } = await open();
	const { transcript, draft } = await openTranscript(library);
	const deletion = expectOk(
		await library.deletionFor(library.entries[0]!.path),
	);
	const removal = holdNext(library.folder.tables.recordings, 'delete');

	const removing = library.remove(deletion);
	await removal.reached;
	// The recording's own file is still being deleted.
	expect(
		draft.change({ body: 'Typed while its recording is deleted.\n' }),
	).toBe(false);
	await draft.saveNow();
	removal.release();
	expect(await removing).toBeUndefined();
	await Bun.sleep(600);

	expect(await Bun.file(join(root, transcript.path)).exists()).toBe(false);
	expect(await readdir(join(root, 'transcriptions'))).toEqual([]);
	expect(draft.state.isDisposed).toBe(true);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('each file of a recording’s deletion stands alone: a refused one keeps its result’s draft, which takes typing and saves again', async () => {
	const { library, root } = await open();
	const { transcript, draft } = await openTranscript(library);
	const recording = library.entries[0]!;
	const row = join(root, recording.path);
	const result = join(root, transcript.path);

	// The recording changed after the person was asked: nothing is deleted.
	let deletion = expectOk(await library.deletionFor(recording.path));
	await writeFile(
		row,
		(await readFile(row, 'utf8')).replace(
			/title: .*/,
			'title: Changed outside',
		),
	);
	expect(await library.remove(deletion)).toContain('different content');
	expect(draft.change({ body: 'Typed after the refusal.\n' })).toBe(true);
	expect(await draft.settle()).toBe(true);
	expect(await readFile(result, 'utf8')).toContain('Typed after the refusal.');

	// Its result changed instead: the recording is deleted, and the result stays.
	await library.refreshAll();
	deletion = expectOk(await library.deletionFor(recording.path));
	const outside = (await readFile(result, 'utf8')).replace(
		'Typed after the refusal.',
		'Changed outside.',
	);
	await writeFile(result, outside);
	expect(await library.remove(deletion)).toContain(
		`these results could not be: ${transcript.path}`,
	);
	expect(await Bun.file(row).exists()).toBe(false);
	expect(await readFile(result, 'utf8')).toBe(outside);
	expect(
		draft.change({ body: 'Typed after its deletion was refused.\n' }),
	).toBe(true);
	expect(await draft.settle()).toBe(true);
	expect(await readFile(result, 'utf8')).toContain(
		'Typed after its deletion was refused.',
	);
});

test('a result being deleted with its recording is not renamed, and keeps taking no typing until the deletion ends', async () => {
	const { library, root } = await open();
	const { transcript, draft } = await openTranscript(library);
	await writeFile(join(root, 'transcriptions', 'taken.md'), 'Someone else\n');
	const deletion = expectOk(
		await library.deletionFor(library.entries[0]!.path),
	);
	const removal = holdNext(library.folder.tables.recordings, 'delete');

	const removing = library.remove(deletion);
	await removal.reached;
	// A rename the folder would refuse, and one it would carry out.
	expect(await library.rename(transcript.path, 'taken.md')).toContain(
		'being moved or deleted',
	);
	expect(await library.rename(transcript.path, 'renamed.md')).toContain(
		'being moved or deleted',
	);
	expect(draft.change({ body: 'Typed after the renames.\n' })).toBe(false);
	await draft.saveNow();
	removal.release();
	expect(await removing).toBeUndefined();
	await Bun.sleep(600);

	expect(await readdir(join(root, 'transcriptions'))).toEqual(['taken.md']);
	expect(draft.state.isDisposed).toBe(true);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('a recording whose result is being renamed is not deleted, and the typing taken meanwhile follows the result', async () => {
	const { library, root } = await open();
	const { transcript, draft } = await openTranscript(library);
	const recording = library.entries[0]!;
	const deletion = expectOk(await library.deletionFor(recording.path));
	const move = holdNext(library.folder.files, 'move');

	const renaming = library.rename(transcript.path, 'renamed.md');
	await move.reached;
	expect(await library.remove(deletion)).toContain('being moved or deleted');
	expect(draft.change({ body: 'Typed while it moved.\n' })).toBe(true);
	move.release();
	expect(await renaming).toBeUndefined();

	const to = 'transcriptions/renamed.md';
	expect(await formOf(library.transcriptAt(to)).settle()).toBe(true);
	expect(await readFile(join(root, to), 'utf8')).toContain(
		'Typed while it moved.',
	);
	expect(await Bun.file(join(root, recording.path)).exists()).toBe(true);

	// Asked again once the list shows it, the renamed result goes with the recording.
	await library.refreshAll();
	const again = expectOk(await library.deletionFor(recording.path));
	expect(await library.remove(again)).toBeUndefined();
	expect(await readdir(join(root, 'transcriptions'))).toEqual([]);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('a rename onto a name whose deletion has not ended is refused, and both files end as asked', async () => {
	const { library, root } = await open();
	await writeFile(join(root, 'old.md'), 'deleted\n');
	await writeFile(join(root, 'notes.md'), 'original\n');
	await library.refreshAll();
	const source = await textDraft(library, 'notes.md');
	const deletion = expectOk(await library.deletionFor('old.md'));
	// The file is removed; the folder's reply has not arrived yet.
	const { files } = library.folder;
	const remove = files.remove;
	const removed = Promise.withResolvers<void>();
	const replied = Promise.withResolvers<void>();
	Object.assign(files, {
		async remove(...args: Parameters<typeof remove>) {
			Object.assign(files, { remove });
			const outcome = await remove(...args);
			removed.resolve();
			await replied.promise;
			return outcome;
		},
	});

	const removing = library.remove(deletion);
	await removed.promise;
	expect(await library.rename('notes.md', 'old.md')).toContain(
		'being moved or deleted',
	);
	source.input(TYPED);
	replied.resolve();
	expect(await removing).toBeUndefined();

	expect(await Bun.file(join(root, 'old.md')).exists()).toBe(false);
	expect(await source.settle()).toBe(true);
	expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(TYPED);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('quit preparation awaits a file command through publication before approving', async () => {
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { library, root } = await open({
		beforeFileCreate: async () => {
			reached.resolve();
			await release.promise;
		},
	});
	const creating = library.createFile('', 'created.txt');
	await reached.promise;
	let approved = false;
	const preparing = library.prepareToLeave().then((safe) => {
		approved = safe;
		return safe;
	});
	await Bun.sleep(10);
	expect(approved).toBe(false);
	release.resolve();
	expect(await creating).toBeUndefined();
	expect(await preparing).toBe(true);
	expect(await readFile(join(root, 'created.txt'), 'utf8')).toBe('');
});

test('quit preparation includes a command accepted while it awaits another', async () => {
	const reached = [
		Promise.withResolvers<void>(),
		Promise.withResolvers<void>(),
	];
	const release = [
		Promise.withResolvers<void>(),
		Promise.withResolvers<void>(),
	];
	let calls = 0;
	const { library } = await open({
		beforeFileCreate: async () => {
			const index = calls++;
			reached[index]!.resolve();
			await release[index]!.promise;
		},
	});
	const first = library.createFile('', 'first.txt');
	await reached[0]!.promise;
	let approved = false;
	const preparing = library.prepareToLeave().then((safe) => {
		approved = safe;
		return safe;
	});
	const second = library.createFile('', 'second.txt');
	await reached[1]!.promise;
	release[0]!.resolve();
	expect(await first).toBeUndefined();
	await Bun.sleep(10);
	expect(approved).toBe(false);
	release[1]!.resolve();
	expect(await second).toBeUndefined();
	expect(await preparing).toBe(true);
});

test('close drains independent accepted commands and refuses a new command', async () => {
	const reached = [
		Promise.withResolvers<void>(),
		Promise.withResolvers<void>(),
	];
	const release = [
		Promise.withResolvers<void>(),
		Promise.withResolvers<void>(),
	];
	let calls = 0;
	const { library, root } = await open({
		beforeFileCreate: async () => {
			const index = calls++;
			reached[index]!.resolve();
			await release[index]!.promise;
		},
	});
	const first = library.createFile('', 'first.txt');
	const second = library.createFile('', 'second.txt');
	await Promise.all(reached.map((command) => command.promise));
	let closed = false;
	const closing = library.close().then(() => {
		closed = true;
	});
	expect(await library.createFile('', 'late.txt')).toContain('closing');
	release[1]!.resolve();
	expect(await second).toBeUndefined();
	await Bun.sleep(10);
	expect(closed).toBe(false);
	release[0]!.resolve();
	expect(await first).toBeUndefined();
	await closing;
	expect(await readFile(join(root, 'first.txt'), 'utf8')).toBe('');
	expect(await readFile(join(root, 'second.txt'), 'utf8')).toBe('');
});
