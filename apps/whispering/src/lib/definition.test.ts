/**
 * Whispering Definition Tests
 *
 * `definition.ts` names only the inert vocabulary, because the page and the
 * Bun folder host both load it. These check it the way an opener does, so a
 * schema a folder cannot keep fails here and not at the first launch.
 *
 * Key behaviors:
 * - The definition is one a file folder accepts
 * - A recording row declares `audioPath`, and reading it infers nothing
 */
import { expect, test } from 'bun:test';
import { defineFolder } from '@epicenter/folder/bun';
import {
	audioPathIn,
	recordingAudioPath,
	whisperingDefinition,
} from './definition.js';

test('a file folder accepts the definition as declared', () => {
	const checked = defineFolder(whisperingDefinition);

	expect(checked.id).toBe('so.epicenter.whispering');
	expect(Object.keys(checked.tables)).toEqual([
		'recordings',
		'transcriptions',
		'transformations',
		'transformation_runs',
	]);
	expect(Object.keys(checked.tables.recordings.fields)).toEqual([
		'title',
		'recordedAt',
		'durationMs',
		'capture',
		'audioPath',
	]);
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
