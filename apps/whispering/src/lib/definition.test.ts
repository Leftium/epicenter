/**
 * Whispering Definition Tests
 *
 * `definition.ts` names only the inert vocabulary, because the page and
 * Whispering's Bun host both load it. These check it the way an opener does,
 * so a schema a folder cannot keep fails here and not at the first launch.
 *
 * Key behaviors:
 * - The definition is one a file folder accepts
 * - A recipe from an earlier build, with string model and endpoint, still
 *   reads without issues, and `null` reads as "use the connection"
 * - A recording row declares `audioPath`, and reading it infers nothing
 */
import { expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineFolder } from '@epicenter/folder/bun';
import {
	audioPathIn,
	recordingAudioPath,
	whisperingDefinition,
} from './definition.js';
import { openTestFolder } from './workspace.test-support.js';

test('a file folder accepts the definition as declared', () => {
	const checked = defineFolder(whisperingDefinition);

	expect(checked.title).toBe('Whispering');
	expect(Object.keys(checked.tables)).toEqual([
		'recordings',
		'transcriptions',
		'transformations',
		'transformation_runs',
		'text_runs',
	]);
	// A result on pasted text names no recording or transcript.
	expect(Object.keys(checked.tables.text_runs.fields)).toEqual([
		'transformationId',
		'transformationTitle',
		'createdAt',
		'model',
		'endpoint',
		'prompt',
		'input',
	]);
	expect(Object.keys(checked.tables.recordings.fields)).toEqual([
		'title',
		'recordedAt',
		'durationMs',
		'capture',
		'audioPath',
	]);
});

test('a recipe written by an earlier build still reads, and a new one says “use the connection” with null', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'whispering-def-')));
	try {
		const folder = await openTestFolder(root);
		const recipes = folder.tables.transformations;
		const earlier = recipes.inspect(
			'---\ntitle: Clean up\nmodel: gpt-4o-mini\nendpoint: https://api.openai.com/v1\n---\nFix it.\n',
		);
		expect(earlier.issues).toEqual([]);
		expect(earlier.fields).toEqual({
			title: 'Clean up',
			model: 'gpt-4o-mini',
			endpoint: 'https://api.openai.com/v1',
		});
		const inherits = recipes.inspect(
			'---\ntitle: Clean up\nmodel: null\nendpoint: null\n---\nFix it.\n',
		);
		expect(inherits.issues).toEqual([]);
		expect(inherits.fields).toEqual({
			title: 'Clean up',
			model: null,
			endpoint: null,
		});
		// A field left out is still an issue: the file says nothing about it.
		expect(
			recipes.inspect('---\ntitle: Clean up\n---\nFix it.\n').issues,
		).toHaveLength(2);
		await folder.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('a recording’s audio is only what its row names', () => {
	expect(recordingAudioPath('20260102-030405-abcd', 'webm')).toBe(
		'recordings/20260102-030405-abcd.webm',
	);
	expect(audioPathIn({ audioPath: 'audio/take.wav' })).toBe('audio/take.wav');
	// A row with no path, or an empty one, names no audio. Nothing is guessed.
	expect(audioPathIn({})).toBeUndefined();
	expect(audioPathIn({ audioPath: '' })).toBeUndefined();
});
