/**
 * Transformation workflow tests
 *
 * Drives the real product state against a real directory and Git repository,
 * with a fixture capture device and stubbed transcription and chat endpoints.
 * No window, provider, key, or network is involved, so these establish the
 * workflow's logic and what it leaves on disk, not that a provider accepts the
 * request.
 *
 * Key behaviors:
 * - Nothing is seeded: a transformation exists only after it is created
 * - A transformation is an ordinary Markdown row: title, model, and endpoint in
 *   frontmatter, the prompt as its body
 * - Applying one writes a new result row and never writes the transcript
 * - A result carries the prompt and text that were sent, so it outlives edits
 *   to, and deletion of, its transformation
 * - A request that fails ends the run, keeps the transcript, and can be retried
 * - A result that cannot be saved keeps its text and its file name; saving it
 *   again does not call the endpoint and cannot make a second result; a row at
 *   that name counts as this result only if its body and whole snapshot match
 * - What is sent is read from the folder when asked: an outside edit is sent,
 *   a deleted or malformed transcript or a deleted recording refuses
 * - A recording cannot be deleted while a request for it runs or its answer is
 *   unsaved, including work that began after the deletion was confirmed
 * - Unknown fields survive edits, a malformed row stays listed and repairable,
 *   and a dirty draft keeps both versions when the file changes outside
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSource } from '@epicenter/folder/bun';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { STARTER_TRANSFORMATIONS } from './definition.js';
import type { Library } from './library.svelte.js';
import { filesLineOf } from './status.js';
import { TransformationError } from './transformation.js';
import {
	deferred,
	openTestWorkspace,
	type TestWorkspaceOptions,
} from './workspace.test-support.js';

const { createLibrary } = await import('./library.svelte.ts');
const { patchRow } = await import('./editor.svelte.ts');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const RUNS = 'transformation_runs';
const CLEANUP = STARTER_TRANSFORMATIONS[0]!;

async function open(options: TestWorkspaceOptions = {}) {
	const test = await openTestWorkspace(options);
	const library = createLibrary(test.workspace);
	cleanups.push(async () => {
		await library.close();
		await test.remove();
	});
	await library.start();
	return { library, ...test };
}

const names = (root: string, directory: string) =>
	readdir(join(root, directory)).catch(() => [] as string[]);

/** A recording with one saved transcript, and the transcript's bytes on disk. */
async function transcribed(library: Library, root: string) {
	await library.startRecording();
	await library.stopRecording();
	const recording = library.entries[0]!;
	await library.transcribe(recording);
	const transcript = library.resultsFor(recording.stem)[0]!;
	return {
		recording,
		transcript,
		transcriptBytes: await readFile(join(root, transcript.path)),
	};
}

/** Create the cleanup starter and give it a model, as a person would before running it. */
async function cleanupProfile(library: Library) {
	expect(await library.createTransformation(CLEANUP)).toBeUndefined();
	const { editor } = library.selectedTransformation!;
	patchRow(editor, { fields: { model: 'chat-model' } });
	await editor.save();
	expect(editor.saveState.kind).toBe('saved');
	return editor;
}

// ============================================================================
// Transformation files
// ============================================================================

test('opening a folder seeds no transformation; creating one writes an ordinary Markdown row', async () => {
	const { library, root } = await open();
	expect(library.transformations).toHaveLength(0);
	expect(await names(root, 'transformations')).toEqual([]);

	expect(await library.createTransformation(CLEANUP)).toBeUndefined();

	expect(library.transformations).toHaveLength(1);
	const entry = library.transformations[0]!;
	expect(entry.issues).toBeUndefined();
	expect(library.selectedTransformationPath).toBe(entry.path);
	const source = await readFile(join(root, entry.path), 'utf8');
	const read = readSource(source);
	// The endpoint starts from the transcription endpoint; the model is the person's to name.
	expect(read.values).toEqual({
		title: 'Clean up',
		model: '',
		endpoint: 'http://127.0.0.1:18080/v1',
	});
	expect(read.body).toBe(CLEANUP.prompt);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a second transformation starts from the first one’s endpoint and model', async () => {
	const { library } = await open();
	const editor = await cleanupProfile(library);
	patchRow(editor, { fields: { endpoint: 'http://127.0.0.1:11434/v1' } });
	await editor.save();
	await library.refresh();

	await library.createTransformation({ title: 'Summarize', prompt: 'Sum.\n' });

	const created = library.selectedTransformation!.entry!;
	expect(created.fields.title).toBe('Summarize');
	expect(created.fields.model).toBe('chat-model');
	expect(created.fields.endpoint).toBe('http://127.0.0.1:11434/v1');
});

test('editing a transformation keeps unknown fields, comments, and the rest of the source', async () => {
	const { library, root } = await open();
	await mkdir(join(root, 'transformations'));
	const source =
		'---\n# kept comment\ntitle: Mine\nmodel: chat-model\nendpoint: http://127.0.0.1:18080/v1\ntemperature: 0.2\n---\nOriginal prompt\n';
	await writeFile(join(root, 'transformations', 'mine.md'), source);
	await library.open('transformations/mine.md');
	const { editor } = library.selectedTransformation!;

	expect(patchRow(editor, { fields: { title: 'Renamed' } })).toBe(true);
	expect(patchRow(editor, { body: 'A new prompt\n' })).toBe(true);
	await editor.save();

	expect(editor.saveState.kind).toBe('saved');
	expect(await readFile(join(root, 'transformations', 'mine.md'), 'utf8')).toBe(
		'---\n# kept comment\ntitle: Renamed\nmodel: chat-model\nendpoint: http://127.0.0.1:18080/v1\ntemperature: 0.2\n---\nA new prompt\n',
	);
	expect(await library.rename(editor.path, 'other.md')).toContain(
		'named by its ID',
	);
});

test('a malformed transformation stays listed, cannot run, and is repaired in its source', async () => {
	const { library, root, transformed } = await open();
	const { transcript } = await transcribed(library, root);
	await mkdir(join(root, 'transformations'));
	const broken = '---\ntitle: *missing\nmood: curious\n---\nStill here\n';
	await writeFile(join(root, 'transformations', 'broken.md'), broken);
	await library.refreshAll();

	const entry = library.transformations.find(
		(item) => item.path === 'transformations/broken.md',
	);
	expect(entry?.issues?.[0]?.kind).toBe('frontmatter');
	await library.open('transformations/broken.md');
	const { editor } = library.selectedTransformation!;
	expect(editor.buffer).toBe(broken);
	// A structured edit is refused; only the source can repair it.
	expect(patchRow(editor, { fields: { title: 'x' } })).toBe(false);
	expect(await library.transform(transcript.path, editor.path)).toContain(
		'needs repair',
	);
	expect(transformed).toHaveLength(0);
	expect(
		await readFile(join(root, 'transformations', 'broken.md'), 'utf8'),
	).toBe(broken);

	editor.input(
		'---\ntitle: Repaired\nmodel: chat-model\nendpoint: http://127.0.0.1:18080/v1\nmood: curious\n---\nStill here\n',
	);
	await editor.save();
	await library.refresh();

	const repaired = library.transformations.find(
		(item) => item.path === 'transformations/broken.md',
	);
	expect(repaired?.issues).toBeUndefined();
	expect(
		await readFile(join(root, 'transformations', 'broken.md'), 'utf8'),
	).toContain('mood: curious');
	expect(await library.transform(transcript.path, editor.path)).toBeUndefined();
	expect(transformed).toHaveLength(1);
});

test('a dirty transformation draft keeps both versions when the file changes outside', async () => {
	const { library, root } = await open();
	const editor = await cleanupProfile(library);
	const path = join(root, editor.path);
	library.autosave.paused = true;
	patchRow(editor, { body: 'My prompt\n' });

	const outside = (await readFile(path, 'utf8')).replace(
		/title: .*/,
		'title: Theirs',
	);
	await writeFile(path, outside);
	await library.refreshAll();

	expect(editor.saveState.kind).toBe('conflict');
	expect(editor.buffer).toContain('My prompt');
	expect(library.saveProblems).toBe(1);
	// Saving is refused while the conflict stands; neither version is written over.
	await editor.save();
	expect(await readFile(path, 'utf8')).toBe(outside);

	const kept = await editor.keepBoth();
	expectOk(kept);
	expect(editor.buffer).toBe(outside);
	expect(await readFile(path, 'utf8')).toBe(outside);
	expect(await readFile(join(root, kept.data!), 'utf8')).toContain('My prompt');
});

test('a clean transformation editor follows an outside edit', async () => {
	const { library, root } = await open();
	const editor = await cleanupProfile(library);
	const path = join(root, editor.path);

	await writeFile(
		path,
		(await readFile(path, 'utf8')).replace(/title: .*/, 'title: From outside'),
	);
	await library.refreshAll();

	expect(editor.saveState.kind).toBe('saved');
	expect(editor.dirty).toBe(false);
	expect(editor.buffer).toContain('title: From outside');
	expect(library.transformations[0]!.fields.title).toBe('From outside');
});

// ============================================================================
// Applying a transformation
// ============================================================================

test('applying a transformation writes a new result row and leaves the transcript untouched', async () => {
	const { library, root, transformed } = await open();
	const { recording, transcript, transcriptBytes } = await transcribed(
		library,
		root,
	);
	const editor = await cleanupProfile(library);
	const profile = library.transformations[0]!;

	expect(await library.transform(transcript.path, editor.path)).toBeUndefined();

	expect(transformed).toEqual([
		{
			baseUrl: 'http://127.0.0.1:18080/v1',
			model: 'chat-model',
			prompt: CLEANUP.prompt,
			input: 'um so a steady tone\n',
		},
	]);
	expect(library.transformationRuns).toHaveLength(0);
	const outputs = library.outputsFor(transcript.stem);
	expect(outputs).toHaveLength(1);
	const output = outputs[0]!;
	expect(output.issues).toBeUndefined();
	expect(output.body).toBe('Transformed: um so a steady tone\n');
	expect(output.fields).toMatchObject({
		recordingId: recording.stem,
		transcriptionId: transcript.stem,
		transformationId: profile.stem,
		transformationTitle: 'Clean up',
		model: 'chat-model',
		endpoint: 'http://127.0.0.1:18080/v1',
		prompt: CLEANUP.prompt,
		input: 'um so a steady tone\n',
	});
	expect(library.outputsOf(profile.stem)).toEqual(outputs);
	// The original transcript is the same bytes, and still the only transcript.
	expect(await readFile(join(root, transcript.path))).toEqual(transcriptBytes);
	expect(await names(root, 'transcriptions')).toHaveLength(1);
	expect(await names(root, RUNS)).toEqual([`${output.stem}.md`]);

	// The result is an ordinary file in ordinary history.
	const committed = await library.commit();
	expect(['committed', 'unchanged']).toContain(committed.status);
	const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
		cwd: root,
		encoding: 'utf8',
	});
	expect(tree).toContain(output.path);
	expect(tree).toContain(profile.path);
});

test('what is sent is the saved transformation: unsaved edits are saved first', async () => {
	const { library, root, transformed } = await open();
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	library.autosave.paused = true;
	patchRow(editor, { body: 'Edited just now.\n' });
	expect(editor.dirty).toBe(true);

	expect(await library.transform(transcript.path, editor.path)).toBeUndefined();

	expect(editor.dirty).toBe(false);
	expect(transformed[0]!.prompt).toBe('Edited just now.\n');
	expect(await readFile(join(root, editor.path), 'utf8')).toContain(
		'Edited just now.',
	);
	expect(library.outputsFor(transcript.stem)[0]!.fields.prompt).toBe(
		'Edited just now.\n',
	);
});

test('a transformation with no model, or a transcript with no text, sends nothing', async () => {
	const { library, root, transformed } = await open();
	const { transcript } = await transcribed(library, root);
	await library.createTransformation(CLEANUP);
	const { editor } = library.selectedTransformation!;

	expect(await library.transform(transcript.path, editor.path)).toContain(
		'no model',
	);
	patchRow(editor, { fields: { model: 'chat-model' } });
	await writeFile(
		join(root, transcript.path),
		transcript.source.replace(transcript.body!, ' \n'),
	);
	expect(await library.transform(transcript.path, editor.path)).toContain(
		'no text',
	);

	expect(transformed).toHaveLength(0);
	expect(library.transformationRuns).toHaveLength(0);
	expect(await names(root, RUNS)).toEqual([]);
});

// ============================================================================
// The folder's current files decide what is sent
// ============================================================================

test('a transcript edited outside is sent as the folder has it now, and is not rewritten', async () => {
	const { library, root, transformed } = await open();
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	// Another program rewrites the transcript and adds a field. No refresh follows.
	await library.refresh();
	const outside = transcript.source
		.replace('---\n', '---\nreviewedBy: someone\n')
		.replace(transcript.body!, 'A steady tone, corrected by hand.\n');
	await writeFile(join(root, transcript.path), outside);
	expect(library.resultsFor(transcript.fields.recordingId!)[0]!.body).toBe(
		'um so a steady tone\n',
	);

	expect(await library.transform(transcript.path, editor.path)).toBeUndefined();

	expect(transformed).toHaveLength(1);
	expect(transformed[0]!.input).toBe('A steady tone, corrected by hand.\n');
	const output = library.outputsFor(transcript.stem)[0]!;
	expect(output.fields.input).toBe('A steady tone, corrected by hand.\n');
	expect(output.body).toBe('Transformed: A steady tone, corrected by hand.\n');
	// The transcript is exactly what the other program wrote, unknown field included.
	expect(await readFile(join(root, transcript.path), 'utf8')).toBe(outside);
});

test('a transcript deleted or broken outside refuses, and nothing stale is sent', async () => {
	const { library, root, transformed } = await open();
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	// Settle the list now, so what it shows below is known to predate the outside changes.
	await library.refresh();

	const broken = '---\nrecordingId: *missing\n---\nStill some text\n';
	await writeFile(join(root, transcript.path), broken);
	expect(await library.transform(transcript.path, editor.path)).toContain(
		'needs repair',
	);
	expect(await readFile(join(root, transcript.path), 'utf8')).toBe(broken);

	await rm(join(root, transcript.path));
	// The list still shows the transcript: nothing has refreshed it.
	expect(library.resultsFor(transcript.fields.recordingId!)).toHaveLength(1);
	expect(await library.transform(transcript.path, editor.path)).toBe(
		'This transcript is no longer in the folder.',
	);

	expect(transformed).toHaveLength(0);
	expect(library.transformationRuns).toHaveLength(0);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a transcript whose recording was deleted outside refuses', async () => {
	const { library, root, transformed } = await open();
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.refresh();
	await rm(join(root, recording.path));
	await rm(join(root, recording.fields.audioPath!));
	// The list still shows the recording: nothing has refreshed it.
	expect(library.entries).toHaveLength(1);

	expect(await library.transform(transcript.path, editor.path)).toBe(
		'The recording this transcript was made from is no longer in the folder.',
	);

	expect(transformed).toHaveLength(0);
	expect(library.transformationRuns).toHaveLength(0);
});

/** The plain text editor Files opens for a transcript's row. */
async function transcriptEditor(library: Library, path: string) {
	await library.open(path);
	const selection = library.selection;
	if (selection?.kind !== 'file' || selection.file.kind !== 'text')
		throw new Error('expected the transcript to open as text');
	return selection.file.editor;
}

test('unsaved edits to the transcript’s file are saved first, then sent', async () => {
	const { library, root, transformed } = await open();
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	const source = await transcriptEditor(library, transcript.path);
	library.autosave.paused = true;
	source.input(
		transcript.source.replace(transcript.body!, 'Typed in Files.\n'),
	);
	expect(source.dirty).toBe(true);

	expect(await library.transform(transcript.path, editor.path)).toBeUndefined();

	expect(source.dirty).toBe(false);
	expect(await readFile(join(root, transcript.path), 'utf8')).toContain(
		'Typed in Files.',
	);
	expect(transformed[0]!.input).toBe('Typed in Files.\n');
});

test('a transcript draft in conflict refuses, and both versions are kept', async () => {
	const { library, root, transformed } = await open();
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	const source = await transcriptEditor(library, transcript.path);
	library.autosave.paused = true;
	source.input(transcript.source.replace(transcript.body!, 'Mine.\n'));
	const outside = transcript.source.replace(transcript.body!, 'Theirs.\n');
	await writeFile(join(root, transcript.path), outside);
	await library.refreshAll();
	expect(source.saveState.kind).toBe('conflict');

	expect(await library.transform(transcript.path, editor.path)).toContain(
		'has edits that are not saved',
	);

	expect(transformed).toHaveLength(0);
	expect(source.buffer).toContain('Mine.');
	expect(await readFile(join(root, transcript.path), 'utf8')).toBe(outside);
});

// ============================================================================
// Deleting a recording while work for it is held
// ============================================================================

test('a recording cannot be deleted while a transformation of it runs, including one started after confirming', async () => {
	const answer =
		deferred<Awaited<ReturnType<Library['workspace']['transform']>>>();
	const { library, root } = await open({ transform: () => answer.promise });
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	// The person is asked, and agrees, before any request exists.
	const confirmed = await library.deletionFor(recording.path);
	expectOk(confirmed);

	const running = library.transform(transcript.path, editor.path);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(library.transformationRuns[0]!.state.kind).toBe('running');

	// Asking now refuses, and so does the deletion already confirmed.
	expect((await library.deletionFor(recording.path)).error).toContain(
		'still running',
	);
	expect(await library.remove(confirmed.data!)).toContain('still running');
	expect((await names(root, 'recordings')).sort()).toEqual([
		`${recording.stem}.md`,
		`${recording.stem}.wav`,
	]);

	answer.resolve(Ok({ text: 'arrived' }));
	await running;

	// The result saved since was never named to the person, so they are asked again.
	expect(await library.remove(confirmed.data!)).toContain(
		'after you were asked',
	);
	expect(await names(root, RUNS)).toHaveLength(1);
	const again = await library.deletionFor(recording.path);
	expect(again.data).toMatchObject({ kind: 'recording' });
	expect(await library.remove(again.data!)).toBeUndefined();
	// The row and the results are gone. The audio is an ordinary file and stays.
	expect(await names(root, 'recordings')).toEqual([`${recording.stem}.wav`]);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a recording cannot be deleted while a received result for it is unsaved; discarding it allows the deletion', async () => {
	const { library, root } = await open({ failRunWrites: 1 });
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	const confirmed = await library.deletionFor(recording.path);
	await library.transform(transcript.path, editor.path);
	const held = library.transformationRuns[0]!;
	expect(held.state.kind).toBe('unsaved');

	const refused = await library.deletionFor(recording.path);
	expect(refused.error).toContain('Save it again or discard it');
	expect(await library.remove(confirmed.data!)).toContain(
		'Save it again or discard it',
	);
	expect(await names(root, 'recordings')).toHaveLength(2);
	// The text is still held, exactly.
	expect(library.transformationRuns[0]!).toEqual(held);

	library.discardTransformationRun(held.id);
	expect(await library.remove(confirmed.data!)).toBeUndefined();

	expect(await names(root, 'recordings')).toEqual([`${recording.stem}.wav`]);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a failed run does not block deletion and is dropped with the recording', async () => {
	const { library, root, transformed } = await open({
		transform: async () =>
			TransformationError.Unreachable({ url: 'http://x', reason: 'down' }),
	});
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.transform(transcript.path, editor.path);
	const failed = library.transformationRuns[0]!;
	expect(failed.state.kind).toBe('failed');

	const deletion = await library.deletionFor(recording.path);
	expect(await library.remove(deletion.data!)).toBeUndefined();

	// Nothing is left that could be retried against the deleted recording.
	expect(library.transformationRuns).toHaveLength(0);
	await library.retryTransformation(failed.id);
	expect(transformed).toHaveLength(1);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a failed run is not sent again once its recording or transcript text is gone from the folder', async () => {
	let refuse = true;
	const { library, root, transformed } = await open({
		transform: async ({ input }) =>
			refuse
				? TransformationError.Unreachable({ url: 'http://x', reason: 'down' })
				: Ok({ text: input }),
	});
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.transform(transcript.path, editor.path);
	const failed = library.transformationRuns[0]!;
	refuse = false;

	// The transcript changes outside: the old request is not what the folder holds.
	await writeFile(
		join(root, transcript.path),
		transcript.source.replace(transcript.body!, 'Different now.\n'),
	);
	await library.retryTransformation(failed.id);
	expect(library.transformationRuns[0]!.state).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('transcript changed'),
	});

	// The recording is deleted outside the app.
	await rm(join(root, recording.path));
	await rm(join(root, recording.fields.audioPath!));
	await library.retryTransformation(failed.id);
	expect(library.transformationRuns[0]!.state).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('no longer in the folder'),
	});

	expect(transformed).toHaveLength(1);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a transformation asked for while its recording is being deleted sends nothing', async () => {
	const { library, root, transformed } = await open();
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	const deletion = await library.deletionFor(recording.path);

	const removing = library.remove(deletion.data!);
	const problem = await library.transform(transcript.path, editor.path);
	expect(await removing).toBeUndefined();

	expect(problem).toMatch(/being deleted|no longer in the folder/);
	expect(transformed).toHaveLength(0);
	expect(library.transformationRuns).toHaveLength(0);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a result outlives edits to its transformation and the transformation’s deletion', async () => {
	const { library, root } = await open();
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.transform(transcript.path, editor.path);
	const output = library.outputsFor(transcript.stem)[0]!;
	const saved = await readFile(join(root, output.path), 'utf8');

	patchRow(editor, { fields: { title: 'Renamed' } });
	patchRow(editor, { body: 'A different prompt.\n' });
	await editor.save();
	await library.refreshAll();
	expect(await readFile(join(root, output.path), 'utf8')).toBe(saved);

	const deletion = await library.deletionFor(editor.path);
	expect(deletion.data).toMatchObject({ kind: 'transformation', results: 1 });
	expect(await library.remove(deletion.data!)).toBeUndefined();

	expect(library.transformations).toHaveLength(0);
	expect(library.selectedTransformation).toBeUndefined();
	expect(await names(root, 'transformations')).toEqual([]);
	expect(await readFile(join(root, output.path), 'utf8')).toBe(saved);
	const kept = library.outputsFor(transcript.stem)[0]!;
	expect(kept.fields.transformationTitle).toBe('Clean up');
	expect(kept.fields.prompt).toBe(CLEANUP.prompt);
});

test('deleting a recording removes the results made from its transcripts', async () => {
	const { library, root } = await open();
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.transform(transcript.path, editor.path);
	expect(await names(root, RUNS)).toHaveLength(1);

	const deletion = await library.deletionFor(recording.path);
	expect(deletion.data).toMatchObject({ kind: 'recording' });
	expect(await library.remove(deletion.data!)).toBeUndefined();

	expect(await names(root, RUNS)).toEqual([]);
	expect(await names(root, 'transcriptions')).toEqual([]);
	// The transformation itself is not the recording's.
	expect(library.transformations).toHaveLength(1);
});

// ============================================================================
// Failures
// ============================================================================

test('a refused request ends the run as failed, keeps the transcript, and retries under the same id', async () => {
	let attempts = 0;
	const { library, root, transformed } = await open({
		transform: async ({ input }) => {
			attempts += 1;
			if (attempts === 1)
				return TransformationError.Rejected({
					url: 'http://127.0.0.1:18080/v1/chat/completions',
					status: 429,
					detail: 'slow down',
				});
			return Ok({ text: `Second try: ${input.trim()}` });
		},
	});
	const { transcript, transcriptBytes } = await transcribed(library, root);
	const editor = await cleanupProfile(library);

	expect(await library.transform(transcript.path, editor.path)).toBeUndefined();

	expect(library.transformationRuns).toHaveLength(1);
	const failed = library.transformationRuns[0]!;
	expect(failed.state).toEqual({
		kind: 'failed',
		message: 'The endpoint answered 429: slow down',
	});
	expect(library.outputsFor(transcript.stem)).toHaveLength(0);
	expect(await names(root, RUNS)).toEqual([]);
	expect(await readFile(join(root, transcript.path))).toEqual(transcriptBytes);
	// Nothing was received, so nothing is held and nothing blocks closing.
	expect(library.holdsUnsavedWork).toBe(false);

	await library.retryTransformation(failed.id);

	expect(transformed).toHaveLength(2);
	expect(transformed[1]).toEqual(transformed[0]!);
	expect(library.transformationRuns).toHaveLength(0);
	const output = library.outputsFor(transcript.stem)[0]!;
	expect(output.stem).toBe(failed.id);
	expect(output.fields.createdAt).toBe(failed.fields.createdAt);
	expect(output.body).toBe('Second try: um so a steady tone\n');
});

test('a transport that throws is a failed run that can be retried, never one left running', async () => {
	let attempts = 0;
	const { library, root } = await open({
		transform: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error('the folder host went away');
			return Ok({ text: 'after the host came back' });
		},
	});
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);

	await library.transform(transcript.path, editor.path);

	const failed = library.transformationRuns[0]!;
	expect(failed.state.kind).toBe('failed');
	if (failed.state.kind === 'failed')
		expect(failed.state.message).toContain('the folder host went away');

	await library.retryTransformation(failed.id);

	expect(library.transformationRuns).toHaveLength(0);
	expect(library.outputsFor(transcript.stem)[0]!.body).toBe(
		'after the host came back\n',
	);
});

test('a running transformation is reported as held until it answers', async () => {
	const answer =
		deferred<Awaited<ReturnType<Library['workspace']['transform']>>>();
	const { library, root } = await open({ transform: () => answer.promise });
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);

	const running = library.transform(transcript.path, editor.path);
	await new Promise((resolve) => setTimeout(resolve, 20));

	expect(library.transformationRuns[0]!.state.kind).toBe('running');
	expect(library.unsavedWork).toContain(
		'A transformation is still running; its result would be lost.',
	);

	answer.resolve(Ok({ text: 'done' }));
	await running;

	expect(library.transformationRuns).toHaveLength(0);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('a result that cannot be saved keeps its text and id; saving again does not call the endpoint', async () => {
	const { library, root, transformed } = await open({ failRunWrites: 2 });
	const { transcript, transcriptBytes } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.commit();
	await library.refreshAll();
	expect(filesLineOf(library).tone).toBe('good');

	await library.transform(transcript.path, editor.path);

	expect(transformed).toHaveLength(1);
	const held = library.transformationRuns[0]!;
	expect(held.state).toMatchObject({
		kind: 'unsaved',
		text: 'Transformed: um so a steady tone',
	});
	expect(library.unsavedTransformations).toBe(1);
	expect(library.unsaved).toBe(true);
	expect(library.holdsUnsavedWork).toBe(true);
	expect(filesLineOf(library)).toMatchObject({
		tone: 'error',
		label: '1 transformation result not saved',
	});
	expect(await names(root, RUNS)).toEqual([]);
	expect(await readFile(join(root, transcript.path))).toEqual(transcriptBytes);

	// A second failed save changes nothing about what is held.
	await library.retryTransformation(held.id);
	const again = library.transformationRuns[0]!;
	expect(again.id).toBe(held.id);
	expect(again.fields).toEqual(held.fields);
	expect(again.state).toMatchObject({
		kind: 'unsaved',
		text: 'Transformed: um so a steady tone',
	});

	await library.retryTransformation(held.id);

	// One request in total, one file, under the id fixed when the run began.
	expect(transformed).toHaveLength(1);
	expect(library.transformationRuns).toHaveLength(0);
	expect(library.unsavedTransformations).toBe(0);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(filesLineOf(library).tone).toBe('good');
	expect(await names(root, RUNS)).toEqual([`${held.id}.md`]);
	const output = library.outputsFor(transcript.stem)[0]!;
	expect(output.stem).toBe(held.id);
	expect(output.fields.createdAt).toBe(held.fields.createdAt);
	expect(output.body).toBe('Transformed: um so a steady tone\n');
});

test('a save that landed but was reported failed is recognized, not written twice', async () => {
	const { library, root, transformed } = await open({ loseRunWriteAnswers: 1 });
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);

	await library.transform(transcript.path, editor.path);

	const held = library.transformationRuns[0]!;
	expect(held.state.kind).toBe('unsaved');
	expect(await names(root, RUNS)).toEqual([`${held.id}.md`]);
	const landed = await readFile(join(root, RUNS, `${held.id}.md`), 'utf8');

	await library.retryTransformation(held.id);

	expect(transformed).toHaveLength(1);
	expect(library.transformationRuns).toHaveLength(0);
	expect(await names(root, RUNS)).toEqual([`${held.id}.md`]);
	expect(await readFile(join(root, RUNS, `${held.id}.md`), 'utf8')).toBe(
		landed,
	);
	expect(library.outputsFor(transcript.stem)).toHaveLength(1);
});

test('another file at the result’s path is never overwritten', async () => {
	const { library, root } = await open({ failRunWrites: 1 });
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.transform(transcript.path, editor.path);
	const held = library.transformationRuns[0]!;
	await mkdir(join(root, RUNS), { recursive: true });
	const squatter = '---\ntitle: not a result\n---\nSomeone else wrote this\n';
	await writeFile(join(root, RUNS, `${held.id}.md`), squatter);

	await library.retryTransformation(held.id);

	const still = library.transformationRuns[0]!;
	expect(still.state.kind).toBe('unsaved');
	if (still.state.kind === 'unsaved') {
		expect(still.state.message).toContain('Nothing was overwritten');
		expect(still.state.text).toBe('Transformed: um so a steady tone');
	}
	expect(await readFile(join(root, RUNS, `${held.id}.md`), 'utf8')).toBe(
		squatter,
	);
});

/** A run whose answer arrived and whose row was not written, with the table that can write rows. */
async function heldRun() {
	const opened = await open({ failRunWrites: 1 });
	const { library, root, workspace } = opened;
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.transform(transcript.path, editor.path);
	const held = library.transformationRuns[0]!;
	if (held.state.kind !== 'unsaved') throw new Error('expected an unsaved run');
	return {
		...opened,
		held,
		text: held.state.text,
		table: workspace.folder.tables.transformation_runs,
	};
}

// Same path, same body, same time, same transcript: only one snapshot field differs.
for (const [field, value] of [
	['prompt', 'A different prompt.\n'],
	['input', 'a different transcript\n'],
	['model', 'another-model'],
	['endpoint', 'http://127.0.0.1:9/v1'],
	['recordingId', '20200101-000000-zzzz'],
	['transformationId', 'another-transformation'],
	['transformationTitle', 'Another title'],
] as const) {
	test(`a row at the result’s path that differs only in ${field} is not this result and is left alone`, async () => {
		const { library, root, table, held, text, transformed } = await heldRun();
		const other = await table.create({
			stem: held.id,
			fields: { ...held.fields, [field]: value } as typeof held.fields,
			body: `${text}\n`,
		});
		expectOk(other);
		const path = join(root, RUNS, `${held.id}.md`);
		const theirs = await readFile(path, 'utf8');

		await library.retryTransformation(held.id);

		const still = library.transformationRuns[0]!;
		expect(still.id).toBe(held.id);
		expect(still.fields).toEqual(held.fields);
		expect(still.state).toMatchObject({
			kind: 'unsaved',
			text,
			message: expect.stringContaining('Nothing was overwritten'),
		});
		expect(await readFile(path, 'utf8')).toBe(theirs);
		expect(library.holdsUnsavedWork).toBe(true);
		expect(transformed).toHaveLength(1);
	});
}

test('this run’s exact row is recognized even with fields the app does not know', async () => {
	const { library, root, table, held, text, transformed } = await heldRun();
	const mine = await table.create({
		stem: held.id,
		fields: held.fields,
		body: `${text}\n`,
	});
	expectOk(mine);
	// Another program annotates the row without touching what the run recorded.
	const annotated = mine.data!.source.replace(
		'---\n',
		'---\n# reviewed\nreviewedBy: someone\n',
	);
	expect((await table.replace(mine.data!, annotated)).error).toBeNull();

	await library.retryTransformation(held.id);

	expect(library.transformationRuns).toHaveLength(0);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(transformed).toHaveLength(1);
	expect(await names(root, RUNS)).toEqual([`${held.id}.md`]);
	expect(await readFile(join(root, RUNS, `${held.id}.md`), 'utf8')).toBe(
		annotated,
	);
});
