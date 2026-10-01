/**
 * Whispering workflow tests
 *
 * Drives the real product state against a real directory and Git repository,
 * with a fixture capture device and a stubbed transcription answer. No window,
 * shell, or microphone is involved, so these establish the workflow's logic and
 * what it leaves on disk, not that the desktop app runs.
 *
 * Key behaviors:
 * - Record, stop, and save produce a row, a same-stem audio file, and a commit
 * - Captured audio and its id survive a partial publication and a retry
 * - A title edit in details and the Source view are one draft
 * - A clean editor follows an outside edit; a dirty one keeps both versions
 * - A malformed row stays listed and its source is untouched
 * - A transcription result is its own row naming the recording
 * - Reopening the folder shows the same recordings and results
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplyError, FileError } from '@epicenter/app/files';
import { openNativeFolder } from '@epicenter/app/files/native';
import { Ok } from 'wellcrafted/result';
import { loadAudio } from './audio-source.js';
import { createFixtureDevice, toneWav } from './capture.js';
import { whisperingDefinition } from './definition.js';
import type { Library } from './library.svelte.js';
import {
	commitLine,
	filesLine,
	summaryLine,
	uncommittedLine,
} from './status.js';
import type { Workspace } from './workspace/types.js';

const { createLibrary } = await import('./library.svelte.ts');
const { patchRecording } = await import('./editor.svelte.ts');

const opened: Library[] = [];
const roots: string[] = [];

type Options = {
	/** Fail this many recording row writes after the audio lands. */
	failRowWrites?: number;
	/** Fail this many transcription result row writes. */
	failResultWrites?: number;
	/** Replace the stubbed transcription answer. */
	transcribe?: Workspace['transcribe'];
	root?: string;
};

async function open({
	failRowWrites = 0,
	failResultWrites = 0,
	transcribe,
	root,
}: Options = {}) {
	const directory =
		root ??
		(await realpath(await mkdtemp(join(tmpdir(), 'whispering-library-'))));
	if (root === undefined) roots.push(directory);
	const folder = await openNativeFolder({
		root: directory,
		definition: whisperingDefinition,
		git: { author: { name: 'Test', email: 'test@localhost' } },
	});
	let remaining = failRowWrites;
	const recordings = folder.tables.recordings;
	let remainingResults = failResultWrites;
	const transcriptions = folder.tables.transcriptions;
	const tables = {
		...folder.tables,
		transcriptions: {
			...transcriptions,
			create: async (input: Parameters<typeof transcriptions.create>[0]) => {
				if (remainingResults === 0) return transcriptions.create(input);
				remainingResults -= 1;
				return FileError.Io({
					path: 'transcriptions/result.md',
					operation: 'create',
					cause: new Error('disk refused the result'),
				});
			},
		},
		recordings: {
			...recordings,
			// What a native folder reports when the audio lands and the row does not.
			create: async (input: Parameters<typeof recordings.create>[0]) => {
				if (remaining === 0 || input.attachment === undefined)
					return recordings.create(input);
				remaining -= 1;
				const audio = `recordings/${input.stem}.${input.attachment.extension}`;
				const landed = await folder.files.write(audio, input.attachment.bytes, {
					expected: 'absent',
				});
				if (landed.error) return landed;
				return ApplyError.Partial({
					applied: [{ kind: 'write', path: audio }],
					failed: { kind: 'write', path: `recordings/${input.stem}.md` },
					error: FileError.Io({
						path: `recordings/${input.stem}.md`,
						operation: 'create',
						cause: new Error('disk refused the row'),
					}).error,
					notAttempted: [],
				});
			},
		},
	};
	const transcribed: { audioPath: string; baseUrl: string; model: string }[] =
		[];
	const changeListeners = new Set<() => void>();
	const workspace: Workspace = {
		kind: 'native',
		folder: { ...folder, tables } as Workspace['folder'],
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
		closing: undefined,
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
	return { library, root: directory, transcribed };
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

test('record, stop, and save leave a row, real audio, and a commit', async () => {
	const { library, root } = await open();

	await record(library);

	expect(library.pending).toHaveLength(0);
	expect(library.entries).toHaveLength(1);
	const entry = library.entries[0]!;
	expect(entry.issues).toBeUndefined();
	expect(entry.fields.capture).toBe('fixture');
	expect(entry.fields.durationMs).toBe(1000);
	expect(entry.attachment).toBe(`recordings/${entry.stem}.wav`);
	expect(library.selectedPath).toBe(entry.path);
	expect(new Uint8Array(await readFile(join(root, entry.attachment!)))).toEqual(
		new Uint8Array(toneWav()),
	);

	const outcome = await library.commit();
	expect(['committed', 'unchanged']).toContain(outcome.status);
	const tree = git(root, 'ls-tree', '-r', '--name-only', 'HEAD');
	expect(tree).toContain(entry.path);
	expect(tree).toContain(entry.attachment!);
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

	expect(patchRecording(editor, { fields: { title: 'Standup notes' } })).toBe(
		true,
	);
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
	patchRecording(editor, { fields: { title: 'Mine' } });
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
	expect(kept.error).toBeNull();
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
	patchRecording(editor, { fields: { title: 'Mine' } });
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
	expect(patchRecording(editor, { fields: { title: 'x' } })).toBe(false);
	expect(await readFile(join(root, 'recordings', 'broken.md'), 'utf8')).toBe(
		broken,
	);

	editor.input(
		'---\ntitle: Repaired\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1\ncapture: microphone\nmood: curious\n---\nStill here\n',
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

test('a transcription is saved as its own row naming the recording', async () => {
	const { library, root, transcribed } = await open();
	await record(library);
	const entry = library.entries[0]!;

	await library.transcribe(entry);

	expect(transcribed).toEqual([
		{
			audioPath: entry.attachment!,
			baseUrl: 'http://127.0.0.1:18080/v1',
			model: 'verification-model',
		},
	]);
	const results = library.resultsFor(entry.stem!);
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
	expect(second.library.entries[0]!.attachment).toBe(entry.attachment);
	expect(second.library.resultsFor(entry.stem!)[0]!.body).toBe(
		'a steady tone\n',
	);
	const opened2 = await second.library.folder.files.open(entry.attachment!);
	expect(new Uint8Array(await opened2.data!.arrayBuffer())).toEqual(
		new Uint8Array(toneWav()),
	);
	expect(git(first.root, 'status', '--porcelain').trim()).toBe('');
});

test('deleting a recording removes its row, audio, and results', async () => {
	const { library, root } = await open();
	await record(library);
	const entry = library.entries[0]!;
	await library.transcribe(entry);

	const deletion = await library.deletionFor(entry.path);
	expect(deletion.error).toBeNull();
	expect(await library.remove(deletion.data!)).toBeUndefined();

	expect(library.entries).toHaveLength(0);
	expect(await readdir(join(root, 'recordings'))).toEqual([]);
	expect(await readdir(join(root, 'transcriptions'))).toEqual([]);
});

/** The header's lines, computed the way AppHeader computes them. */
function status(library: Library) {
	const files = filesLine({
		saving: library.saving,
		problems: library.saveProblems,
		unsaved: library.unsaved,
		pendingCaptures: library.pending.length,
		capturesSaving: library.pending.some(
			(item) => item.state.kind === 'saving',
		),
		unsavedResults: library.unsavedResults,
	});
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
	const path = entry.attachment!;
	const first = await loadAudio(library.folder.files, path, undefined);
	expect(first.error).toBeNull();

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

	const failed = library.transcriptionRun(entry.stem!);
	expect(failed?.kind).toBe('failed');
	if (failed?.kind === 'failed')
		expect(failed.message).toContain('the folder host went away');
	expect(library.resultsFor(entry.stem!)).toHaveLength(0);

	await library.transcribe(entry);

	expect(attempts).toBe(2);
	expect(library.transcriptionRun(entry.stem!)).toBeUndefined();
	expect(library.resultsFor(entry.stem!)[0]!.body).toBe('second try\n');
});

test('a transcript whose file was not saved is reported as unsaved until it is', async () => {
	const { library, root } = await open({ failResultWrites: 1 });
	await record(library);
	await library.commit();
	await library.refreshAll();
	const entry = library.entries[0]!;
	expect(status(library).files.tone).toBe('good');

	await library.transcribe(entry);

	const run = library.transcriptionRun(entry.stem!);
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

	await library.retrySaveResult(entry.stem!);

	expect(library.unsavedResults).toBe(0);
	expect(library.unsaved).toBe(false);
	expect(status(library).files.tone).toBe('good');
	expect(library.resultsFor(entry.stem!)[0]!.body).toBe('a steady tone\n');
	expect(await readdir(join(root, 'transcriptions'))).toHaveLength(1);
});
