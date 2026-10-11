/**
 * The host's read of one audio file, against a real directory.
 *
 * The host does not open the folder, so this is the whole of what stands
 * between a path the page sends and a file on disk. These establish that the
 * path is taken literally, that nothing outside the folder or behind a link is
 * read, that only a regular file is read, and that what is returned is a copy
 * the caller owns.
 */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { readAudio } from './audio.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const AUDIO = new Uint8Array([82, 73, 70, 70, 0, 1, 2, 3, 255]);
const SECRET = new TextEncoder().encode('not for the endpoint');

/** A data folder with audio in it, beside a directory that is not the folder. */
async function folder() {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-audio-')),
	);
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const root = join(directory, 'data');
	const outside = join(directory, 'outside');
	await mkdir(join(root, 'recordings'), { recursive: true });
	await mkdir(join(root, 'Imported', '2026 takes'), { recursive: true });
	await mkdir(join(root, '.git'), { recursive: true });
	await mkdir(outside);
	await writeFile(join(root, 'recordings', 'take.wav'), AUDIO);
	await writeFile(
		join(root, 'Imported', '2026 takes', 'Voice Memo.m4a'),
		AUDIO,
	);
	await writeFile(join(root, '.git', 'config'), SECRET);
	await writeFile(join(outside, 'secret.wav'), SECRET);
	return { directory, root, outside };
}

test('a saved audio file is read as its exact bytes, at any depth and under any name', async () => {
	const { root } = await folder();

	expect(expectOk(await readAudio(root, 'recordings/take.wav'))).toEqual(AUDIO);
	expect(
		expectOk(await readAudio(root, 'Imported/2026 takes/Voice Memo.m4a')),
	).toEqual(AUDIO);
});

test('the bytes returned are a copy: changing the file afterward does not change them', async () => {
	const { root } = await folder();
	const read = expectOk(await readAudio(root, 'recordings/take.wav'));

	await writeFile(join(root, 'recordings', 'take.wav'), SECRET);
	await rm(join(root, 'recordings', 'take.wav'));

	expect(read).toEqual(AUDIO);
});

test('a path that is not a literal folder-relative path is refused before the disk is touched', async () => {
	const { root, outside } = await folder();

	for (const [path, reason] of [
		['', 'the path is empty'],
		['../outside/secret.wav', 'the path contains a relative segment'],
		[
			'recordings/../../outside/secret.wav',
			'the path contains a relative segment',
		],
		['./recordings/take.wav', 'the path contains a relative segment'],
		[join(outside, 'secret.wav'), 'the path must be folder-relative'],
		['/recordings/take.wav', 'the path must be folder-relative'],
		['recordings\\take.wav', 'the path contains a backslash'],
		['recordings//take.wav', 'the path contains an empty segment'],
		['recordings/take.wav/', 'the path contains an empty segment'],
		['recordings/take\n.wav', 'the path contains a control character'],
		['recordings/take\u0000.wav', 'the path contains a control character'],
		['.git/config', 'the path is inside private Git state'],
		['.GIT/config', 'the path is inside private Git state'],
		['recordings/.git/config', 'the path is inside private Git state'],
	] as const) {
		const refused = expectErr(await readAudio(root, path));
		expect(refused.name).toBe('InvalidPath');
		if (refused.name === 'InvalidPath') expect(refused.reason).toBe(reason);
	}
});

test('a name spelled differently from its directory entry is not that file', async () => {
	const { root } = await folder();

	// On a case-insensitive disk these would open the same file. Each component
	// must be listed under exactly this spelling.
	for (const path of [
		'Recordings/take.wav',
		'recordings/Take.wav',
		'recordings/take.WAV',
		'imported/2026 takes/Voice Memo.m4a',
		'Imported/2026 Takes/Voice Memo.m4a',
	])
		expect(expectErr(await readAudio(root, path)).name).toBe('NotFound');
});

test('a missing file, a directory, and a file used as a directory are each refused as what they are', async () => {
	const { root } = await folder();

	expect(expectErr(await readAudio(root, 'recordings/gone.wav')).name).toBe(
		'NotFound',
	);
	expect(expectErr(await readAudio(root, 'nowhere/take.wav')).name).toBe(
		'NotFound',
	);
	expect(expectErr(await readAudio(root, 'recordings')).name).toBe('NotAFile');
	expect(expectErr(await readAudio(root, 'Imported/2026 takes')).name).toBe(
		'NotAFile',
	);
	const through = expectErr(
		await readAudio(root, 'recordings/take.wav/inner.wav'),
	);
	expect(through.name).toBe('NotADirectory');
	if (through.name === 'NotADirectory')
		expect(through.path).toBe('recordings/take.wav');
});

test('a symbolic link is never followed, whether it points inside the folder or out of it', async () => {
	const { root, outside } = await folder();
	// The last component, to a file inside and to one outside.
	await symlink(
		join(root, 'recordings', 'take.wav'),
		join(root, 'recordings', 'inside-link.wav'),
	);
	await symlink(
		join(outside, 'secret.wav'),
		join(root, 'recordings', 'outside-link.wav'),
	);
	// A directory on the way, to one inside and to one outside.
	await symlink(join(root, 'recordings'), join(root, 'alias'));
	await symlink(outside, join(root, 'elsewhere'));
	// A link to nothing.
	await symlink(join(root, 'missing.wav'), join(root, 'dangling.wav'));

	for (const path of [
		'recordings/inside-link.wav',
		'recordings/outside-link.wav',
		'alias/take.wav',
		'elsewhere/secret.wav',
		'dangling.wav',
	]) {
		const refused = expectErr(await readAudio(root, path));
		expect(refused.name).toBe('InvalidPath');
		if (refused.name === 'InvalidPath')
			expect(refused.reason).toBe('the path passes through a symbolic link');
	}
});

test('something that is not a regular file is refused without being opened', async () => {
	const { root } = await folder();
	const pipe = join(root, 'recordings', 'pipe.wav');
	execFileSync('mkfifo', [pipe]);

	// Opening a pipe for reading waits for a writer. This must return at once.
	const refused = expectErr(
		await Promise.race([
			readAudio(root, 'recordings/pipe.wav'),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error('the read waited on the pipe')),
					2000,
				),
			),
		]),
	);

	expect(refused.name).toBe('InvalidPath');
	if (refused.name === 'InvalidPath')
		expect(refused.reason).toBe('the path is not a regular file');
});
