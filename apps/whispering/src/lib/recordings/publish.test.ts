/**
 * Publication and recovery against a real directory and a real Git repository.
 *
 * What these establish: a capture keeps its id and bytes across a partial
 * publication, a retry completes it without creating a second recording, a
 * repeated retry writes nothing, and recovery refuses to replace a row or
 * audio file it did not write.
 */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeFolder } from '@epicenter/app/files/native';
import { toneWav } from '../capture.js';
import { type RecordingFields, whisperingDefinition } from '../definition.js';
import { type PendingCapture, publishRecording } from './publish.js';

const roots: string[] = [];

async function open() {
	const root = await mkdtemp(join(tmpdir(), 'whispering-publish-'));
	roots.push(root);
	const folder = await openNativeFolder({
		root,
		definition: whisperingDefinition,
		git: { author: { name: 'Test', email: 'test@localhost' } },
	});
	return { root, folder };
}

afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

function capture(id = '20260102-030405-abcd'): PendingCapture {
	return {
		id,
		bytes: toneWav(),
		extension: 'wav',
		fields: {
			title: 'First take',
			recordedAt: '2026-01-02T03:04:05.000Z',
			durationMs: 1000,
			capture: 'fixture',
		} as RecordingFields,
	};
}

const git = (root: string, ...args: string[]) =>
	execFileSync('git', args, { cwd: root, encoding: 'utf8' });

test('a capture is saved as a row and a same-stem audio file, then committed', async () => {
	const { root, folder } = await open();
	const pending = capture();

	const outcome = await publishRecording(folder, pending);

	expect(outcome.status).toBe('saved');
	if (outcome.status !== 'saved') return;
	expect(outcome.recovered).toBe(false);
	expect(outcome.entry.attachment).toBe(`recordings/${pending.id}.wav`);
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual([
		`${pending.id}.md`,
		`${pending.id}.wav`,
	]);
	expect(
		new Uint8Array(
			await readFile(join(root, 'recordings', `${pending.id}.wav`)),
		),
	).toEqual(new Uint8Array(pending.bytes));

	const committed = await folder.git.commit();
	expect(['committed', 'unchanged']).toContain(committed.status);
	// The committed tree holds the audio bytes themselves, not a pointer.
	const blob = execFileSync(
		'git',
		['cat-file', 'blob', `HEAD:recordings/${pending.id}.wav`],
		{ cwd: root },
	);
	expect(new Uint8Array(blob)).toEqual(new Uint8Array(pending.bytes));
	expect(git(root, 'show', `HEAD:recordings/${pending.id}.md`)).toContain(
		'title: First take',
	);
	await folder.close();
});

test('audio that landed without its row is completed by a retry under the same id', async () => {
	const { root, folder } = await open();
	const pending = capture();
	// The state a native partial publication leaves: audio saved, no row.
	const landed = await folder.files.write(
		`recordings/${pending.id}.wav`,
		pending.bytes,
		{ expected: 'absent' },
	);
	expect(landed.error).toBeNull();

	const outcome = await publishRecording(folder, pending);

	expect(outcome.status).toBe('saved');
	if (outcome.status !== 'saved') return;
	expect(outcome.recovered).toBe(true);
	expect(outcome.entry.issues).toBeUndefined();
	expect(outcome.entry.fields.title).toBe('First take');
	expect(outcome.entry.attachment).toBe(`recordings/${pending.id}.wav`);
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual([
		`${pending.id}.md`,
		`${pending.id}.wav`,
	]);
	await folder.close();
});

test('retrying a published capture writes nothing and reports the same recording', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const first = await publishRecording(folder, pending);
	expect(first.status).toBe('saved');
	const before = await readFile(
		join(root, 'recordings', `${pending.id}.md`),
		'utf8',
	);

	const again = await publishRecording(folder, pending);

	expect(again.status).toBe('saved');
	if (again.status !== 'saved') return;
	expect(again.recovered).toBe(true);
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toBe(before);
	expect(await readdir(join(root, 'recordings'))).toHaveLength(2);
	await folder.close();
});

test('recovery never replaces audio it did not write', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const other = new Uint8Array([1, 2, 3, 4]);
	await folder.files.write(`recordings/${pending.id}.wav`, other, {
		expected: 'absent',
	});

	const outcome = await publishRecording(folder, pending);

	expect(outcome.status).toBe('unexpected');
	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${pending.id}.wav`,
	]);
	expect(
		new Uint8Array(
			await readFile(join(root, 'recordings', `${pending.id}.wav`)),
		),
	).toEqual(other);
	await folder.close();
});

test('recovery never replaces a row it did not write', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const foreign = '---\ntitle: Someone else\n---\nKeep me\n';
	await folder.files.write(`recordings/${pending.id}.md`, foreign, {
		expected: 'absent',
	});

	const outcome = await publishRecording(folder, pending);

	expect(outcome.status).toBe('unexpected');
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toBe(foreign);
	expect(await readdir(join(root, 'recordings'))).toEqual([`${pending.id}.md`]);
	await folder.close();
});

test('a same-stem file with another extension blocks publication', async () => {
	const { root, folder } = await open();
	const pending = capture();
	await folder.files.write(
		`recordings/${pending.id}.m4a`,
		new Uint8Array([9]),
		{
			expected: 'absent',
		},
	);

	const outcome = await publishRecording(folder, pending);

	expect(outcome.status).toBe('unexpected');
	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${pending.id}.m4a`,
	]);
	await folder.close();
});
