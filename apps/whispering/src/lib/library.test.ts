/**
 * Whispering workflow tests
 *
 * Drives the real product state against a real directory and Git repository,
 * with a fixture capture device and a stubbed transcription answer. No window,
 * shell, or microphone is involved, so these establish the workflow's logic and
 * what it leaves on disk, not that the desktop app runs.
 *
 * Key behaviors:
 * - A first launch creates `kv.json` only after reading that it is absent
 * - A settings save assigns its values in the current file, creates the file
 *   from those values when it is gone, and tries a changed file once more
 * - Record, stop, and save produce audio, a row that names it, and a commit
 * - Captured audio and its id survive a partial publication and a retry
 * - A row that names no audio says so: nothing is guessed from a file's name
 * - Deleting a recording deletes its row and results and keeps its audio
 * - A title edit in details and the Source view are one draft
 * - A clean editor follows an outside edit; a dirty one keeps both versions
 * - A malformed row stays listed and its source is untouched
 * - A recording whose filename needs repair keeps its literal ID: nothing is
 *   sent for it, and its draft, conflict review, and deletion act on that file
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
import { FileError } from '@epicenter/folder/bun';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { loadAudio } from './audio-source.js';
import { createFixtureDevice, toneWav } from './capture.js';
import { describeDeletion } from './deletion-copy.js';
import type { Library } from './library.svelte.js';
import {
	commitLine,
	filesLine,
	filesLineOf,
	summaryLine,
	uncommittedLine,
} from './status.js';
import type { Workspace } from './workspace/types.js';
import {
	batchWithRecordingFailures,
	openTestFolder,
} from './workspace.test-support.js';

const { createLibrary } = await import('./library.svelte.ts');
const { patchRow } = await import('./editor.svelte.ts');

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
				if (remainingLostReplies === 0 || created.error) return created;
				remainingLostReplies -= 1;
				return FileError.Unconfirmed({
					path: created.data.path,
					operation: 'create',
					cause: 'reply lost after the write',
				});
			},
		},
	};
	// The folder's own batch fails at the row, after the audio landed.
	const batch = batchWithRecordingFailures(folder, directory, {
		audio: 0,
		row: failRowWrites,
	});
	const transcribed: { audioPath: string; baseUrl: string; model: string }[] =
		[];
	const changeListeners = new Set<() => void>();
	const workspace: Workspace = {
		kind: 'native',
		folder: {
			...folder,
			tables,
			batch,
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
		close: () => folder.close(),
	};
	const library = createLibrary(workspace);
	opened.push(library);
	await library.start();
	return { library, root: directory, transcribed, failures };
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

function recordingEditor(library: Library) {
	const selection = library.selection;
	if (selection?.kind !== 'recording')
		throw new Error(`Expected a recording, got ${selection?.kind}`);
	return selection.editor;
}

test('the first launch writes kv.json with the transcription settings', async () => {
	const { root } = await open();
	const kv = JSON.parse(await readFile(join(root, 'kv.json'), 'utf8'));
	expect(kv).toEqual({
		transcriptionBaseUrl: 'http://127.0.0.1:18080/v1',
		transcriptionModel: 'verification-model',
	});
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
	// The settings a first launch would have written still show.
	expect(library.settings.transcriptionModel).toBe('verification-model');
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

	expect(reads).toBe(4);
	expect(creates).toBe(0);
	expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe(existing);
	expect(library.settingsProblem).toBeUndefined();
	expect(library.settings.transcriptionModel).toBe('kept');
});

test('saving settings after kv.json was deleted creates it from the saved values alone', async () => {
	const calls: string[] = [];
	const { library, root } = await open({
		kv: (real) => ({
			get: () => {
				calls.push('get');
				return real.get();
			},
			create: (values) => {
				calls.push('create');
				return real.create(values);
			},
			update: (values) => {
				calls.push('update');
				return real.update(values);
			},
		}),
	});
	await rm(join(root, 'kv.json'));
	await library.refresh();
	calls.length = 0;

	expect(
		await library.saveSettings({ transcriptionModel: 'chosen' }),
	).toBeUndefined();

	// One attempt: no read before it, and the listing's read after it.
	expect(calls).toEqual(['update', 'create', 'get']);
	expect(JSON.parse(await readFile(join(root, 'kv.json'), 'utf8'))).toEqual({
		transcriptionModel: 'chosen',
	});
	// The endpoint was not saved, so it still shows its initial value.
	expect(library.settings).toEqual({
		transcriptionBaseUrl: 'http://127.0.0.1:18080/v1',
		transcriptionModel: 'chosen',
	});
	expect(library.settingsProblem).toBeUndefined();
});

test('a settings save that meets a changed file is tried once more, and twice is reported', async () => {
	let conflicts = 0;
	const calls: string[] = [];
	const { library, root } = await open({
		kv: (real) => ({
			...real,
			update: async (values) => {
				calls.push('update');
				if (conflicts === 0) return real.update(values);
				conflicts -= 1;
				return FileError.Conflict({
					path: 'kv.json',
					expectedSha256: 'a'.repeat(64),
					actualSha256: 'b'.repeat(64),
				});
			},
			create: async (values) => {
				calls.push('create');
				return real.create(values);
			},
		}),
	});
	const saved = () => readFile(join(root, 'kv.json'), 'utf8');

	calls.length = 0;
	conflicts = 1;
	expect(
		await library.saveSettings({ transcriptionModel: 'second-try' }),
	).toBeUndefined();
	expect(calls).toEqual(['update', 'update']);
	expect(JSON.parse(await saved())).toEqual({
		transcriptionBaseUrl: 'http://127.0.0.1:18080/v1',
		transcriptionModel: 'second-try',
	});
	expect(library.settings.transcriptionModel).toBe('second-try');

	calls.length = 0;
	conflicts = 2;
	const before = await saved();
	expect(await library.saveSettings({ transcriptionModel: 'never' })).toContain(
		'keeps changing',
	);
	expect(calls).toEqual(['update', 'update']);
	expect(await saved()).toBe(before);
	expect(library.settings.transcriptionModel).toBe('second-try');
});

test('a settings save reports a file that appeared first, or an unconfirmed write, without trying again', async () => {
	const calls: string[] = [];
	let racing = false;
	let unconfirmed = false;
	const theirs = '{"transcriptionModel": "theirs"}\n';
	const { library, root } = await open({
		kv: (real) => ({
			...real,
			update: async (values) => {
				calls.push('update');
				if (!unconfirmed) return real.update(values);
				return FileError.Unconfirmed({
					path: 'kv.json',
					operation: 'replace',
					cause: 'reply lost',
				});
			},
			create: async (values) => {
				calls.push('create');
				// Another writer makes the file between the update's read and this create.
				if (racing) await writeFile(join(root, 'kv.json'), theirs);
				return real.create(values);
			},
		}),
	});

	await rm(join(root, 'kv.json'));
	calls.length = 0;
	racing = true;
	expect(await library.saveSettings({ transcriptionModel: 'mine' })).toContain(
		'already exists',
	);
	expect(calls).toEqual(['update', 'create']);
	expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe(theirs);

	calls.length = 0;
	unconfirmed = true;
	expect(await library.saveSettings({ transcriptionModel: 'mine' })).toContain(
		'may have completed',
	);
	expect(calls).toEqual(['update']);
	expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe(theirs);
});

test('record, stop, and save leave a row, real audio, and a commit', async () => {
	const { library, root } = await open();

	await record(library);

	expect(library.pending).toHaveLength(0);
	expect(library.entries).toHaveLength(1);
	const entry = library.entries[0]!;
	expect(entry.issues).toBeUndefined();
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
	expect(tree).toContain('kv.json');
});

test('a partial publication keeps the audio and id, and retry makes one recording', async () => {
	const { library, root } = await open({ failRowWrites: 1 });

	await record(library);

	expect(library.entries).toHaveLength(0);
	expect(library.pending).toHaveLength(1);
	const pending = library.pending[0]!;
	expect(pending.state.kind).toBe('partial');
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

test('renaming in details and editing the source are one draft, saved to the row', async () => {
	const { library, root } = await open();
	await record(library);
	const editor = recordingEditor(library);

	expect(patchRow(editor, { fields: { title: 'Standup notes' } })).toBe(true);
	// The Source view shows the same unsaved text the details changed.
	expect(editor.buffer).toContain('title: Standup notes');
	expect(editor.dirty).toBe(true);
	editor.input(`${editor.buffer}Typed in the source view\n`);
	await editor.save();

	expect(editor.saveState.kind).toBe('saved');
	const saved = await readFile(join(root, editor.path), 'utf8');
	expect(saved).toContain('title: Standup notes');
	expect(saved).toContain('Typed in the source view');
	await library.refresh();
	expect(library.entries[0]!.fields.title).toBe('Standup notes');
	expect(await library.rename(editor.path, 'other.md')).toContain(
		'named by its ID',
	);
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

	expect(editor.saveState.kind).toBe('saved');
	expect(editor.dirty).toBe(false);
	expect(editor.buffer).toContain('title: Edited outside');
	expect(library.entries[0]!.fields.title).toBe('Edited outside');
});

test('a dirty editor keeps both versions when the file changes outside, until a choice', async () => {
	const { library, root } = await open();
	await record(library);
	const editor = recordingEditor(library);
	const path = join(root, editor.path);
	library.autosave.paused = true;
	patchRow(editor, { fields: { title: 'Mine' } });
	expect(editor.dirty).toBe(true);

	const outside = (await readFile(path, 'utf8')).replace(
		/title: .*/,
		'title: Theirs',
	);
	await writeFile(path, outside);
	await library.refreshAll();

	expect(editor.saveState.kind).toBe('conflict');
	expect(editor.buffer).toContain('title: Mine');
	if (editor.saveState.kind !== 'conflict') return;
	expect(editor.saveState.current?.source).toBe(outside);
	expect(await readFile(path, 'utf8')).toBe(outside);
	// Saving is refused while the conflict stands; neither version is written over.
	await editor.save();
	expect(await readFile(path, 'utf8')).toBe(outside);
	expect(library.saveProblems).toBe(1);

	const kept = await editor.keepBoth();
	expectOk(kept);
	expect(editor.saveState.kind as string).toBe('saved');
	expect(editor.buffer).toBe(outside);
	expect(await readFile(path, 'utf8')).toBe(outside);
	expect(await readFile(join(root, kept.data!), 'utf8')).toContain(
		'title: Mine',
	);
});

test('choosing mine saves over the reviewed outside version', async () => {
	const { library, root } = await open();
	await record(library);
	const editor = recordingEditor(library);
	const path = join(root, editor.path);
	library.autosave.paused = true;
	patchRow(editor, { fields: { title: 'Mine' } });
	await writeFile(
		path,
		(await readFile(path, 'utf8')).replace(/title: .*/, 'title: Theirs'),
	);
	await library.refreshAll();
	expect(editor.saveState.kind).toBe('conflict');

	await editor.keepMine();

	expect(editor.saveState.kind).toBe('saved');
	expect(await readFile(path, 'utf8')).toContain('title: Mine');
});

test('a malformed row stays listed and its bytes are not rewritten', async () => {
	const { library, root } = await open();
	await record(library);
	const broken = '---\ntitle: *missing\nmood: curious\n---\nStill here\n';
	await writeFile(join(root, 'recordings', 'broken.md'), broken);
	await library.refreshAll();

	const entry = library.entries.find(
		(item) => item.path === 'recordings/broken.md',
	);
	expect(entry?.issues?.[0]?.kind).toBe('frontmatter');
	await library.open('recordings/broken.md');
	const editor = recordingEditor(library);
	expect(editor.buffer).toBe(broken);
	// A structured edit is refused; only the source can repair it.
	expect(patchRow(editor, { fields: { title: 'x' } })).toBe(false);
	expect(await readFile(join(root, 'recordings', 'broken.md'), 'utf8')).toBe(
		broken,
	);

	editor.input(
		'---\ntitle: Repaired\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1\ncapture: microphone\naudioPath: recordings/broken.wav\nmood: curious\n---\nStill here\n',
	);
	await editor.save();
	await library.refresh();
	const repaired = library.entries.find(
		(item) => item.path === 'recordings/broken.md',
	);
	expect(repaired?.issues).toBeUndefined();
	expect(
		await readFile(join(root, 'recordings', 'broken.md'), 'utf8'),
	).toContain('mood: curious');
});

test('a recording whose filename needs repair is never sent, and is edited, reviewed, and deleted at its literal ID', async () => {
	const { library, root, transcribed } = await open();
	await record(library);
	const recorded = library.entries[0]!;
	// The same valid row under a name the naming rules refuse.
	const path = 'recordings/bad .md';
	await writeFile(join(root, path), recorded.source);
	await library.refreshAll();
	const entry = library.entries.find((item) => item.path === path)!;
	expect(entry.stem).toBe('bad ');
	expect(entry.issues?.map((issue) => issue.kind)).toEqual(['filename']);

	// The row names real audio, and still no request leaves for it.
	await library.transcribe(entry);
	expect(transcribed).toEqual([]);
	expect(library.transcriptionRun(entry.stem)).toBeUndefined();

	await library.open(path);
	const editor = recordingEditor(library);
	library.autosave.paused = true;
	patchRow(editor, { fields: { title: 'Mine' } });
	const outside = recorded.source.replace(/title: .*/, 'title: Theirs');
	await writeFile(join(root, path), outside);
	await editor.save();
	// The refused save rereads this row, not a neighbor and not nothing.
	expect(editor.saveState).toMatchObject({
		kind: 'conflict',
		current: { path, stem: 'bad ', source: outside },
	});
	expect(editor.buffer).toContain('title: Mine');
	expect(await readFile(join(root, path), 'utf8')).toBe(outside);

	await editor.keepMine();
	expect(editor.saveState.kind as string).toBe('saved');
	expect(await readFile(join(root, path), 'utf8')).toContain('title: Mine');

	const deletion = await library.deletionFor(path);
	expect(deletion.data).toMatchObject({
		kind: 'recording',
		entry: { path, stem: 'bad ' },
	});
	expect(await library.remove(deletion.data!)).toBeUndefined();
	expect(library.entries.map((item) => item.path)).toEqual([recorded.path]);
});

test('a transcription is saved as its own row naming the recording', async () => {
	const { library, root, transcribed } = await open();
	await record(library);
	const entry = library.entries[0]!;

	await library.transcribe(entry);

	expect(transcribed).toEqual([
		{
			audioPath: entry.fields.audioPath!,
			baseUrl: 'http://127.0.0.1:18080/v1',
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
	const opened2 = await second.library.folder.files.open(
		entry.fields.audioPath!,
	);
	expect(new Uint8Array(await opened2.data!.arrayBuffer())).toEqual(
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

	const deletion = await library.deletionFor(entry.path);
	expectOk(deletion);
	// What the person is asked matches what the deletion does.
	const asked = describeDeletion(deletion.data!, library.recordingNaming);
	expect(asked.description).toContain(
		`This deletes ${entry.path}, 1 transcription result from the folder.`,
	);
	expect(asked.description).toContain(`Its audio ${audioPath} is not deleted`);
	expect(await library.remove(deletion.data!)).toBeUndefined();

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
	const file = await library.deletionFor(audioPath);
	expect(file.data).toMatchObject({ kind: 'file', path: audioPath });
	expect(await library.remove(file.data!)).toBeUndefined();
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

	const deletion = await library.deletionFor(audioPath);
	const asked = describeDeletion(deletion.data!, library.recordingNaming);
	expect(asked.description).toContain('names it as its audio and is kept');
	expect(await library.remove(deletion.data!)).toBeUndefined();

	expect(await readdir(join(root, 'recordings'))).toEqual([`${entry.stem}.md`]);
	expect(library.entries).toHaveLength(1);
	// The row still names the path; the missing file is reported, not hidden.
	expect(library.entries[0]!.fields.audioPath).toBe(audioPath);
	const loaded = await loadAudio(library.folder.files, audioPath, undefined);
	expect(loaded.error?.name).toBe('NotFound');
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
	expect(entry.issues).toEqual([
		{ kind: 'field', field: 'audioPath', message: 'The field is missing' },
	]);
	expect(entry.fields.audioPath).toBeUndefined();
	// The file beside it is an ordinary file that no recording names.
	expect(library.recordingNaming('recordings/old.wav')).toBeUndefined();

	await library.transcribe(entry);

	expect(transcribed).toHaveLength(0);
	const run = library.transcriptionRun('old');
	expect(run?.kind).toBe('failed');
	if (run?.kind === 'failed') expect(run.message).toContain('names no audio');
	// Nothing was migrated or rewritten.
	expect(await readFile(join(root, 'recordings', 'old.md'), 'utf8')).toBe(old);

	// The person repairs it in Source by naming the audio.
	await library.open('recordings/old.md');
	const editor = recordingEditor(library);
	expect(
		patchRow(editor, { fields: { audioPath: 'recordings/old.wav' } }),
	).toBe(true);
	await editor.save();
	await library.refresh();
	const repaired = library.entries.find((item) => item.stem === 'old')!;
	expect(repaired.issues).toBeUndefined();
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

	patchRow(editor, { fields: { title: 'A new title' } });
	await editor.save();
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
	const confirmed = await library.deletionFor(entry.path);
	expectOk(confirmed);

	const transcribing = library.transcribe(entry);
	expect(library.transcriptionRun(entry.stem)?.kind).toBe('running');

	expect((await library.deletionFor(entry.path)).error).toContain(
		'still running',
	);
	expect(await library.remove(confirmed.data!)).toContain('still running');
	expect(await readdir(join(root, 'recordings'))).toHaveLength(2);

	answer(Ok({ text: 'arrived late' }));
	await transcribing;

	// The transcript saved since was never named to the person, so they are asked again.
	expect(await library.remove(confirmed.data!)).toContain(
		'after you were asked',
	);
	expect(await readdir(join(root, 'transcriptions'))).toHaveLength(1);
	const again = await library.deletionFor(entry.path);
	expect(await library.remove(again.data!)).toBeUndefined();
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

	const refused = await library.deletionFor(entry.path);
	expect(refused.error).toContain('Save it again or discard it');
	expect(await readdir(join(root, 'recordings'))).toHaveLength(2);
	const run = library.transcriptionRun(entry.stem);
	if (run?.kind !== 'unsaved') throw new Error('expected the transcript held');
	expect(run.text).toBe('a steady tone');

	library.dismissRun(entry.stem);
	const deletion = await library.deletionFor(entry.path);
	expect(await library.remove(deletion.data!)).toBeUndefined();

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
	const first = await loadAudio(library.folder.files, path, undefined);
	expectOk(first);

	// Unchanged audio is the same object, so a player keeps what it has.
	const before = library.generation;
	await library.refreshAll();
	expect(library.generation).toBeGreaterThan(before);
	const again = await loadAudio(library.folder.files, path, first.data!);
	expect(again.data).toBe(first.data!);

	const replaced = new Uint8Array(toneWav({ frequency: 880 }));
	expect(replaced.length).toBe(toneWav().length);
	await writeFile(join(root, path), replaced);
	// A refresh is what tells a mounted player to look again.
	const generation = library.generation;
	await library.refreshAll();
	expect(library.generation).toBeGreaterThan(generation);

	const next = await loadAudio(library.folder.files, path, first.data!);
	expect(next.data).not.toBe(first.data!);
	expect(next.data!.blob.size).toBe(first.data!.blob.size);
	expect(new Uint8Array(await next.data!.blob.arrayBuffer())).toEqual(replaced);
	expect(next.data!.blob.type).toBe('audio/wav');
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

test('a confirmed publication with failed observation stays saved and retry never republishes', async () => {
	const { library, root } = await open();
	const folder = library.folder;
	const batch = folder.batch;
	const table = folder.tables.recordings;
	const get = table.get;
	let batches = 0;
	let refuseObservation = true;
	Object.assign(folder, {
		batch: (collect: Parameters<typeof batch>[0]) => {
			batches += 1;
			return batch(collect);
		},
	});
	Object.assign(table, {
		get: (stem: string) =>
			batches > 0 && refuseObservation
				? Promise.resolve(
						FileError.Io({
							path: `recordings/${stem}.md`,
							operation: 'read',
							cause: new Error('read after publication failed'),
						}),
					)
				: get(stem),
	});
	await record(library);
	const pending = library.pending[0]!;
	expect(batches).toBe(1);
	expect(pending.capture.bytes).toEqual(toneWav());
	expect(filesLineOf(library).label).not.toContain('not saved');
	expect(library.unsavedWork).toEqual([]);
	const path = join(root, 'recordings', `${pending.capture.id}.md`);
	const source = await readFile(path, 'utf8');
	await rm(path);
	refuseObservation = false;
	await library.retryPending(pending.capture.id);
	expect(batches).toBe(1);
	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${pending.capture.id}.wav`,
	]);
	expect(library.pending[0]!.capture.id).toBe(pending.capture.id);
	expect(library.pending[0]!.capture.bytes).toEqual(toneWav());
	await writeFile(path, source);
	await library.retryPending(pending.capture.id);
	expect(batches).toBe(1);
	expect(library.pending).toHaveLength(0);
	expect(library.entries[0]!.stem).toBe(pending.capture.id);
});

/** Record once with the read-back after the batch refused, counting every batch and request. */
async function publishedButUnshown() {
	const started = await open();
	const { library } = started;
	const folder = library.folder;
	const batch = folder.batch;
	const table = folder.tables.recordings;
	const get = table.get;
	const seen = { batches: 0, refuse: true };
	Object.assign(folder, {
		batch: (collect: Parameters<typeof batch>[0]) => {
			seen.batches += 1;
			return batch(collect);
		},
	});
	Object.assign(table, {
		get: (stem: string) =>
			seen.batches > 0 && seen.refuse
				? Promise.resolve(
						FileError.Io({
							path: `recordings/${stem}.md`,
							operation: 'read',
							cause: new Error('read after publication failed'),
						}),
					)
				: get(stem),
	});
	await record(library);
	return { ...started, seen, held: library.pending[0]! };
}

test('a confirmed publication is reported as saved with a separate observation problem, and holds nothing', async () => {
	const { library, root, seen, held, transcribed } =
		await publishedButUnshown();

	// The product state says what is true: published, and not shown.
	expect(held.state).toMatchObject({
		kind: 'published',
		problem: 'unreadable',
		checking: false,
		publication: {
			audio: { path: held.capture.fields.audioPath },
			row: { path: `recordings/${held.capture.id}.md` },
		},
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

	// Still unreadable: looking again changes nothing and publishes nothing.
	await library.retryPending(held.capture.id);
	expect(seen.batches).toBe(1);
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
	expect(seen.batches).toBe(1);
	expect(library.pending).toHaveLength(0);
	expect(library.selectedPath).toBe(`recordings/${held.capture.id}.md`);
	expect(recordingEditor(library).baseline.source).toBe(
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

	expect(seen.batches).toBe(1);
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

	expect(seen.batches).toBe(1);
	expect(library.pending).toHaveLength(0);
	expect(await readFile(path, 'utf8')).toBe(edited);
	const editor = recordingEditor(library);
	expect(editor.baseline.source).toBe(edited);
	expect(editor.dirty).toBe(false);
	expect(library.entries[0]!.fields.title).toBe('Renamed since');
});

test('dismissing a published notice drops the window’s copy and changes nothing in the folder', async () => {
	const { library, root, seen, held } = await publishedButUnshown();
	const before = (await readdir(join(root, 'recordings'))).sort();

	library.discardPending(held.capture.id);

	expect(library.pending).toHaveLength(0);
	expect(seen.batches).toBe(1);
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual(before);
	expect(status(library).files.label).toBe('All changes saved to files');
});

test('a partial publication is still unresolved: it is reported as not saved and holds the app open', async () => {
	const { library } = await open({ failRowWrites: 1 });
	await record(library);

	expect(library.pending[0]!.state.kind).toBe('partial');
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

test('a late observation cannot restore a published notice that was dismissed', async () => {
	const { library, seen, held } = await publishedButUnshown();
	const reply =
		Promise.withResolvers<
			Awaited<ReturnType<typeof library.folder.tables.recordings.get>>
		>();
	Object.assign(library.folder.tables.recordings, { get: () => reply.promise });
	const refreshing = library.retryPending(held.capture.id);
	library.discardPending(held.capture.id);
	reply.resolve(
		FileError.Io({
			path: `recordings/${held.capture.id}.md`,
			operation: 'read',
			cause: new Error('late read failure'),
		}),
	);
	await refreshing;
	expect(library.pending).toHaveLength(0);
	expect(library.selectedPath).toBeUndefined();
	expect(seen.batches).toBe(1);
});

test('a late successful observation cannot select a dismissed recording', async () => {
	const { library, seen, held } = await publishedButUnshown();
	const entry = library.entries[0]!;
	const reply =
		Promise.withResolvers<
			Awaited<ReturnType<typeof library.folder.tables.recordings.get>>
		>();
	Object.assign(library.folder.tables.recordings, { get: () => reply.promise });
	const refreshing = library.retryPending(held.capture.id);
	library.discardPending(held.capture.id);
	reply.resolve(Ok(entry));
	await refreshing;
	expect(library.pending).toHaveLength(0);
	expect(library.selectedPath).toBeUndefined();
	expect(seen.batches).toBe(1);
});

test('a late observation does not replace a file selected while it was reading', async () => {
	const { library, seen, held } = await publishedButUnshown();
	const entry = library.entries[0]!;
	const reply =
		Promise.withResolvers<
			Awaited<ReturnType<typeof library.folder.tables.recordings.get>>
		>();
	Object.assign(library.folder.tables.recordings, { get: () => reply.promise });
	const refreshing = library.retryPending(held.capture.id);
	const created = await library.folder.files.create(
		'other.txt',
		'Another open file',
	);
	expectOk(created);
	await library.open('other.txt');
	expect(library.selectedPath).toBe('other.txt');
	reply.resolve(Ok(entry));
	await refreshing;
	expect(library.pending).toHaveLength(0);
	expect(library.selectedPath).toBe('other.txt');
	expect(seen.batches).toBe(1);
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
	expect(library.resultsFor(id).map((result) => result.body)).toEqual([
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
			.map((result) => result.body)
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
	expect((await library.deletionFor(entry.path)).error).toContain(
		'Save it again or discard it',
	);
	expect(library.unsavedWork).toEqual([
		'1 transcript arrived but its file is not saved.',
	]);
	expect(await library.prepareToLeave()).toBe(false);

	// Discarding drops the text. The write already begun is still on its way to the folder.
	library.dismissRun(id);
	expect(library.holdsUnsavedWork).toBe(false);
	expect((await library.deletionFor(entry.path)).error).toContain(
		'still being written',
	);
	expect(await readdir(join(root, 'recordings'))).toHaveLength(2);

	write.release('write');
	await saving;

	// The transcript that landed is named to the person before it is deleted.
	const deletion = await library.deletionFor(entry.path);
	if (deletion.data?.kind !== 'recording')
		throw new Error('expected a recording deletion');
	expect(deletion.data.results).toHaveLength(1);
	expect(await library.remove(deletion.data)).toBeUndefined();
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
	expect((await library.deletionFor(entry.path)).error).toContain(
		'still running',
	);
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
	const confirmed = await library.deletionFor(entry.path);
	if (confirmed.data?.kind !== 'recording')
		throw new Error('expected a recording deletion');
	expect(confirmed.data.results).toEqual([]);
	const lists = holdResultLists(library);

	const transcribing = library.transcribe(entry);
	await lists.started;

	// The row is written and nothing is held; only the listing has not arrived.
	expect(library.transcriptionRun(id)).toBeUndefined();
	expect(library.unsaved).toBe(false);
	expect(library.resultsFor(id)).toEqual([]);
	const [name] = await transcripts(root);
	const saved = await readFile(join(root, 'transcriptions', name!), 'utf8');

	expect(await library.remove(confirmed.data)).toContain(
		'after you were asked',
	);

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
	const again = await library.deletionFor(entry.path);
	if (again.data?.kind !== 'recording')
		throw new Error('expected a recording deletion');
	expect(again.data.results.map((result) => result.path)).toEqual([
		`transcriptions/${name}`,
	]);
	expect(await library.remove(again.data)).toBeUndefined();
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
	const confirmed = await library.deletionFor(entry.path);
	if (confirmed.data?.kind !== 'recording')
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

	expect(await library.remove(confirmed.data)).toContain(
		'after you were asked',
	);
	expect(await readdir(join(root, 'recordings'))).toHaveLength(2);
	expect(await transcripts(root)).toEqual([name!]);

	// A new confirmation names the transcript from its publication, with the listing still failing.
	const again = await library.deletionFor(entry.path);
	if (again.data?.kind !== 'recording')
		throw new Error('expected a recording deletion');
	expect(again.data.results.map((result) => result.path)).toEqual([
		`transcriptions/${name}`,
	]);
	expect(await library.remove(again.data)).toBeUndefined();
	expect(await transcripts(root)).toEqual([]);
	expect(await readdir(join(root, 'recordings'))).toEqual([`${id}.wav`]);

	Object.assign(table, { list });
	await library.refresh();
	expect(library.entries).toEqual([]);
	expect(library.resultsFor(id)).toEqual([]);
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
