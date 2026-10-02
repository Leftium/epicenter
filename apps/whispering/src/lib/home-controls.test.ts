/**
 * Home controls tests: post-processing choice and the settings draft
 *
 * Drives a real session over a real directory with stubbed endpoints that
 * count every request. No component is mounted, so these establish what the
 * controls' state does and what reaches the folder and the endpoints, not how
 * the controls look.
 *
 * Key behaviors:
 * - A session starts with post-processing set to None and no transformation
 *   in the folder
 * - Choosing a transformation, recording, stopping, and transcribing send no
 *   transformation request; only an explicit run does, once
 * - A run saves a separate result file and leaves the transcript's file as
 *   it was
 * - The choice is read against the folder: a deleted transformation is
 *   missing, and one that lacks its model needs repair, and neither runs
 * - The settings form has one draft: it saves the endpoint and model to
 *   `kv.json`, sends a typed key to the device only, keeps the current key
 *   when none is typed, and asks no endpoint anything
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { STARTER_TRANSFORMATIONS } from './definition.js';
import { resolvePostProcessing } from './post-processing.js';
import type { Session } from './session.svelte.js';
import type { Workspace } from './workspace/types.js';
import { openTestWorkspace } from './workspace.test-support.js';

const { openSession } = await import('./session.svelte.ts');
const { patchRow } = await import('./editor.svelte.ts');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(
	change: (workspace: Workspace) => Workspace = (workspace) => workspace,
) {
	const test = await openTestWorkspace();
	const transcribed: unknown[] = [];
	const workspace = change({
		...test.workspace,
		async transcribe(request) {
			transcribed.push(request);
			return Ok({ text: 'um so a steady tone' });
		},
	});
	const session: Session = expectOk(
		await openSession(async () => Ok(workspace)),
	);
	cleanups.push(async () => {
		await session.close();
		await test.remove();
	});
	return {
		session,
		library: session.library,
		view: session.view,
		transcribed,
		...test,
	};
}

const names = (root: string, directory: string) =>
	readdir(join(root, directory)).catch(() => [] as string[]);

/** Create the cleanup starter, optionally with the model a run needs. */
async function cleanup(session: Session, model?: string) {
	const { library } = session;
	expect(
		await library.createTransformation(STARTER_TRANSFORMATIONS[0]!),
	).toBeUndefined();
	const { editor } = library.selectedTransformation!;
	if (model !== undefined) {
		patchRow(editor, { fields: { model } });
		await editor.save();
		await library.refreshAll();
	}
	return library.transformations[0]!;
}

test('a session starts with post-processing set to None and seeds no transformation', async () => {
	const { library, view, root, transformed } = await open();

	expect(view.postProcessing).toBeUndefined();
	expect(
		resolvePostProcessing(view.postProcessing, library.transformations),
	).toEqual({ kind: 'none' });
	expect(library.transformations).toEqual([]);
	expect(await names(root, 'transformations')).toEqual([]);
	expect(transformed).toEqual([]);
});

test('choosing, recording, stopping, and transcribing send nothing to the transformation; an explicit run sends it once', async () => {
	const { session, library, view, root, transformed, transcribed } =
		await open();
	const profile = await cleanup(session, 'chat-model');

	view.postProcessing = profile.path;
	expect(
		resolvePostProcessing(view.postProcessing, library.transformations).kind,
	).toBe('ready');
	await library.startRecording();
	await library.stopRecording();
	// Nothing is transcribed by recording either.
	expect(transcribed).toEqual([]);
	await library.transcribe(library.entries[0]!);
	await library.refreshAll();

	expect(transformed).toEqual([]);
	expect(await names(root, 'transformation_runs')).toEqual([]);
	// The choice is the session's: a page change builds nothing new, so it is still chosen.
	expect(session.view.postProcessing).toBe(profile.path);

	const transcript = library.resultsFor(library.entries[0]!.stem)[0]!;
	const before = await readFile(join(root, transcript.path));
	expect(
		await library.transform(transcript.path, profile.path),
	).toBeUndefined();

	expect(transformed).toHaveLength(1);
	expect(transformed[0]).toMatchObject({
		model: 'chat-model',
		input: 'um so a steady tone\n',
	});
	expect(await names(root, 'transformation_runs')).toHaveLength(1);
	expect(library.outputsFor(transcript.stem)).toHaveLength(1);
	expect(library.transformationRuns).toEqual([]);
	expect((await readFile(join(root, transcript.path))).equals(before)).toBe(
		true,
	);
});

test('a chosen transformation that was deleted is missing, and one without its model needs repair; neither is run', async () => {
	const { session, library, view, root, transformed } = await open();
	const profile = await cleanup(session);
	view.postProcessing = profile.path;

	// A new transformation has no model until the person gives it one.
	expect(
		resolvePostProcessing(view.postProcessing, library.transformations).kind,
	).toBe('repair');

	await rm(join(root, profile.path));
	await library.refreshAll();

	expect(
		resolvePostProcessing(view.postProcessing, library.transformations),
	).toEqual({
		kind: 'missing',
		path: profile.path,
	});
	// The choice is shown as it is, not replaced.
	expect(view.postProcessing).toBe(profile.path);
	expect(transformed).toEqual([]);
});

test('the folder being read is reported while it is read, and not after', async () => {
	const { library } = await open();
	expect(library.refreshing).toBe(false);

	const reading = library.refresh();
	expect(library.refreshing).toBe(true);
	await reading;

	expect(library.refreshing).toBe(false);
});

test('the settings draft saves the model and endpoint to kv.json and a typed key to the device only', async () => {
	const keys: string[] = [];
	const { session, library, root, transcribed, transformed } = await open(
		(workspace) => ({
			...workspace,
			credential: {
				...workspace.credential,
				async set(key) {
					keys.push(key);
					return undefined;
				},
			},
		}),
	);
	const { settings } = session;
	expect(settings.model).toBe('verification-model');

	settings.model = ' local-whisper ';
	settings.baseUrl = 'http://127.0.0.1:9000/v1';
	expect(await settings.save()).toBeUndefined();

	// No key was typed, so the current key is kept: nothing is sent to the device.
	expect(keys).toEqual([]);
	expect(JSON.parse(await readFile(join(root, 'kv.json'), 'utf8'))).toEqual({
		transcriptionBaseUrl: 'http://127.0.0.1:9000/v1',
		transcriptionModel: 'local-whisper',
	});
	expect(library.settings.transcriptionModel).toBe('local-whisper');
	// The draft follows what was saved.
	expect(settings.model).toBe('local-whisper');

	settings.apiKey = 'typed-key';
	expect(await settings.save()).toBeUndefined();

	expect(keys).toEqual(['typed-key']);
	expect(settings.apiKey).toBe('');
	expect(library.credentialPresent).toBe(true);
	expect(await readFile(join(root, 'kv.json'), 'utf8')).not.toContain(
		'typed-key',
	);
	// Saving settings asks no endpoint anything.
	expect(transcribed).toEqual([]);
	expect(transformed).toEqual([]);
});

test('a key the device refuses is reported, stays typed, and leaves the saved settings saved', async () => {
	const { session, library } = await open((workspace) => ({
		...workspace,
		credential: {
			...workspace.credential,
			set: async () => 'The key comes from the environment.',
		},
	}));
	const { settings } = session;

	settings.model = 'another-model';
	settings.apiKey = 'typed-key';

	expect(await settings.save()).toEqual({
		title: 'Could not save the key',
		description: 'The key comes from the environment.',
	});
	expect(settings.apiKey).toBe('typed-key');
	expect(settings.saving).toBe(false);
	expect(library.settings.transcriptionModel).toBe('another-model');
	expect(library.credentialPresent).toBe(false);
});
