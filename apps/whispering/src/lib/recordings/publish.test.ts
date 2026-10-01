/**
 * Recording Publication Tests
 *
 * Publication and recovery against a real directory and a real Git
 * repository, through the folder's own batch. Failures are real: a directory
 * placed where a step writes makes the folder fail that step itself.
 *
 * Key behaviors:
 * - A capture is one batch: the audio, then a row that names it in `audioPath`
 * - Audio that landed without its row is completed under the same id, by a
 *   batch that lands only if the audio is still exactly what was read
 * - A retry of a published capture writes nothing
 * - Foreign audio, same-size changed audio, a foreign row, and a row without
 *   its audio all refuse and are left as found
 * - A file that only shares the stem is not the recording's and blocks nothing
 * - A lost reply is not success, and the next attempt recognizes what landed
 * - A complete receipt is a publication. A row that then cannot be read, or
 *   that another writer removed or replaced, is reported as published with an
 *   observation problem; looking again only reads and repairs nothing
 */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureVersion, FileError } from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';
import { toneWav } from '../capture.js';
import type { RecordingFields } from '../definition.js';
import {
	batchWithRecordingFailures,
	openTestFolder,
} from '../workspace.test-support.js';
import {
	observePublication,
	type PendingCapture,
	type PublishTarget,
	publishRecording,
} from './publish.js';

const roots: string[] = [];

async function open() {
	const root = await mkdtemp(join(tmpdir(), 'whispering-publish-'));
	roots.push(root);
	return { root, folder: await openTestFolder(root) };
}

afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

function capture(id = '20260102-030405-abcd'): PendingCapture {
	return {
		id,
		bytes: toneWav(),
		fields: {
			title: 'First take',
			recordedAt: '2026-01-02T03:04:05.000Z',
			durationMs: 1000,
			capture: 'fixture',
			audioPath: `recordings/${id}.wav`,
		} as RecordingFields,
		body: '',
	};
}

const git = (root: string, ...args: string[]) =>
	execFileSync('git', args, { cwd: root, encoding: 'utf8' });

const bytesAt = async (...path: string[]) =>
	new Uint8Array(await readFile(join(...path)));

const names = async (root: string) =>
	(await readdir(join(root, 'recordings'))).sort();

// ============================================================================
// Publication
// ============================================================================

test('a capture is saved as audio and a row that names it, then committed and restorable with Git', async () => {
	const { root, folder } = await open();
	const pending = capture();

	const outcome = await publishRecording(folder, pending);

	expect(outcome.status).toBe('saved');
	if (outcome.status !== 'saved') return;
	expect(outcome.recovered).toBe(false);
	expect(outcome.entry.issues).toBeUndefined();
	expect(outcome.entry.fields).toEqual(pending.fields);
	expect(outcome.entry.fields.audioPath).toBe(`recordings/${pending.id}.wav`);
	expect(await names(root)).toEqual([`${pending.id}.md`, `${pending.id}.wav`]);
	// The stored audio is the captured bytes, exactly.
	expect(await bytesAt(root, 'recordings', `${pending.id}.wav`)).toEqual(
		new Uint8Array(pending.bytes),
	);
	const opened = expectOk(await folder.files.open(pending.fields.audioPath));
	expect(new Uint8Array(await opened.arrayBuffer())).toEqual(
		new Uint8Array(pending.bytes),
	);

	const committed = await folder.git.commit();
	expect(['committed', 'unchanged']).toContain(committed.status);
	// The committed tree holds the audio bytes themselves, not a pointer.
	const blob = execFileSync(
		'git',
		['cat-file', 'blob', `HEAD:recordings/${pending.id}.wav`],
		{ cwd: root },
	);
	expect(new Uint8Array(blob)).toEqual(new Uint8Array(pending.bytes));
	const row = git(root, 'show', `HEAD:recordings/${pending.id}.md`);
	expect(row).toContain('title: First take');
	expect(row).toContain(`audioPath: recordings/${pending.id}.wav`);
	await folder.close();

	// Ordinary Git, with no app involved, restores a playable recording.
	const restored = await mkdtemp(join(tmpdir(), 'whispering-restore-'));
	roots.push(restored);
	execFileSync('git', ['clone', '--quiet', root, join(restored, 'clone')]);
	expect(
		await bytesAt(restored, 'clone', 'recordings', `${pending.id}.wav`),
	).toEqual(new Uint8Array(pending.bytes));
	expect(
		await readFile(
			join(restored, 'clone', 'recordings', `${pending.id}.md`),
			'utf8',
		),
	).toBe(row);
});

test('a file that only shares the stem is not the recording’s and does not block it', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const sibling = new Uint8Array([9, 9, 9]);
	expectOk(await folder.files.create(`recordings/${pending.id}.m4a`, sibling));
	expectOk(await folder.files.create(`recordings/${pending.id}.txt`, 'note'));

	const outcome = await publishRecording(folder, pending);

	expect(outcome.status).toBe('saved');
	if (outcome.status !== 'saved') return;
	expect(outcome.recovered).toBe(false);
	// The row names its own audio; the sibling is neither named nor touched.
	expect(outcome.entry.fields.audioPath).toBe(`recordings/${pending.id}.wav`);
	expect(await names(root)).toEqual([
		`${pending.id}.m4a`,
		`${pending.id}.md`,
		`${pending.id}.txt`,
		`${pending.id}.wav`,
	]);
	expect(await bytesAt(root, 'recordings', `${pending.id}.m4a`)).toEqual(
		sibling,
	);
	await folder.close();
});

// ============================================================================
// Partial publication and recovery
// ============================================================================

test('a row that fails after the audio landed is a real partial publication, completed by a retry under the same id', async () => {
	const { root, folder } = await open();
	const pending = capture();
	// Twice, a directory is in the way where the row is written: the folder's
	// own step fails there, after its first step has saved the audio.
	const target: PublishTarget = {
		...folder,
		batch: batchWithRecordingFailures(folder, root, { audio: 0, row: 2 }),
	};

	const first = await publishRecording(target, pending);

	expect(first.status).toBe('partial');
	if (first.status !== 'partial') return;
	expect(first.landed).toEqual([`recordings/${pending.id}.wav`]);
	expect(await bytesAt(root, 'recordings', `${pending.id}.wav`)).toEqual(
		new Uint8Array(pending.bytes),
	);
	// The capture is what it was: nothing about it changed by failing.
	expect(pending).toEqual(capture());
	// A partial publication requests no commit.
	await folder.git.status();
	expect(expectOk(await folder.git.log(10))).toEqual([]);

	// Still obstructed: the recovery batch replaces the audio it read with the
	// same bytes and fails at the row again. Nothing is lost or duplicated.
	const second = await publishRecording(target, pending);
	expect(second.status).toBe('partial');
	if (second.status === 'partial')
		expect(second.landed).toEqual([`recordings/${pending.id}.wav`]);
	expect(await names(root)).toEqual([`${pending.id}.wav`]);
	expect(await bytesAt(root, 'recordings', `${pending.id}.wav`)).toEqual(
		new Uint8Array(pending.bytes),
	);

	const third = await publishRecording(target, pending);

	expect(third.status).toBe('saved');
	if (third.status !== 'saved') return;
	expect(third.recovered).toBe(true);
	expect(third.entry.stem).toBe(pending.id);
	expect(third.entry.fields).toEqual(pending.fields);
	expect(await names(root)).toEqual([`${pending.id}.md`, `${pending.id}.wav`]);
	expect(await bytesAt(root, 'recordings', `${pending.id}.wav`)).toEqual(
		new Uint8Array(pending.bytes),
	);
	// A save is not a commit: history is asked for separately and holds both files.
	expect((await folder.git.commit()).status).not.toBe('failed');
	expect(
		git(root, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n').sort(),
	).toEqual([`recordings/${pending.id}.md`, `recordings/${pending.id}.wav`]);
	await folder.close();
});

test('audio that fails first leaves nothing in the folder, and a retry saves', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const target: PublishTarget = {
		...folder,
		batch: batchWithRecordingFailures(folder, root, { audio: 1, row: 0 }),
	};

	const first = await publishRecording(target, pending);

	expect(first.status).toBe('failed');
	expect(await names(root)).toEqual([]);

	const second = await publishRecording(target, pending);
	expect(second.status).toBe('saved');
	if (second.status === 'saved') expect(second.recovered).toBe(false);
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
	let batches = 0;
	const counting: PublishTarget = {
		...folder,
		batch: (collect) => {
			batches += 1;
			return folder.batch(collect);
		},
	};

	const again = await publishRecording(counting, pending);

	expect(again.status).toBe('saved');
	if (again.status !== 'saved') return;
	expect(again.recovered).toBe(true);
	expect(batches).toBe(0);
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toBe(before);
	expect(await names(root)).toHaveLength(2);
	await folder.close();
});

test('a published recording whose title was edited since is still this recording', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const first = await publishRecording(folder, pending);
	if (first.status !== 'saved') throw new Error('expected the capture saved');
	expectOk(
		await folder.tables.recordings.update(first.entry, {
			fields: { title: 'Renamed by its owner' },
		}),
	);

	const again = await publishRecording(folder, pending);

	expect(again.status).toBe('saved');
	// Nothing was rewritten: the edited title is still there, in the same file.
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toContain('title: Renamed by its owner');
	expect(await names(root)).toEqual([`${pending.id}.md`, `${pending.id}.wav`]);
	await folder.close();
});

// ============================================================================
// Refusals
// ============================================================================

test('audio it did not write is never replaced', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const other = new Uint8Array([1, 2, 3, 4]);
	expectOk(await folder.files.create(pending.fields.audioPath, other));

	const outcome = await publishRecording(folder, pending);

	expect(outcome.status).toBe('unexpected');
	if (outcome.status === 'unexpected')
		expect(outcome.path).toBe(pending.fields.audioPath);
	expect(await names(root)).toEqual([`${pending.id}.wav`]);
	expect(await bytesAt(root, 'recordings', `${pending.id}.wav`)).toEqual(other);
	await folder.close();
});

test('audio of the same size with other bytes is not this capture’s and is never replaced', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const other = new Uint8Array(toneWav({ frequency: 880 }));
	expect(other.byteLength).toBe(pending.bytes.byteLength);
	expect(other).not.toEqual(new Uint8Array(pending.bytes));
	expectOk(await folder.files.create(pending.fields.audioPath, other));

	const outcome = await publishRecording(folder, pending);

	expect(outcome.status).toBe('unexpected');
	expect(await names(root)).toEqual([`${pending.id}.wav`]);
	expect(await bytesAt(root, 'recordings', `${pending.id}.wav`)).toEqual(other);
	await folder.close();
});

test('audio changed between the read and the recovery batch refuses the whole batch', async () => {
	const { root, folder } = await open();
	const pending = capture();
	expectOk(await folder.files.create(pending.fields.audioPath, pending.bytes));
	const other = new Uint8Array(toneWav({ frequency: 880 }));
	// Another writer saves over the audio right after this attempt read it.
	const raced: PublishTarget = {
		...folder,
		files: {
			async read(path) {
				const read = await folder.files.read(path);
				if (read.error === null)
					expectOk(await folder.files.overwrite(path, other));
				return read;
			},
		},
	};

	const outcome = await publishRecording(raced, pending);

	expect(outcome.status).toBe('unexpected');
	if (outcome.status === 'unexpected')
		expect(outcome.path).toBe(pending.fields.audioPath);
	// The condition held the row back: no row beside audio that is not this capture's.
	expect(await names(root)).toEqual([`${pending.id}.wav`]);
	expect(await bytesAt(root, 'recordings', `${pending.id}.wav`)).toEqual(other);
	await folder.close();
});

test('a row it did not write is never replaced', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const foreign = '---\ntitle: Someone else\n---\nKeep me\n';
	expectOk(await folder.files.create(`recordings/${pending.id}.md`, foreign));

	const outcome = await publishRecording(folder, pending);

	expect(outcome.status).toBe('unexpected');
	if (outcome.status === 'unexpected')
		expect(outcome.path).toBe(`recordings/${pending.id}.md`);
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toBe(foreign);
	expect(await names(root)).toEqual([`${pending.id}.md`]);
	await folder.close();
});

test('a row from before audioPath is not this recording, even beside matching audio', async () => {
	const { root, folder } = await open();
	const pending = capture();
	// What the earlier layout wrote: no audioPath, the audio beside the row.
	const old =
		'---\ntitle: First take\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1000\ncapture: fixture\n---\n';
	expectOk(await folder.files.create(`recordings/${pending.id}.md`, old));
	expectOk(await folder.files.create(pending.fields.audioPath, pending.bytes));

	const outcome = await publishRecording(folder, pending);

	expect(outcome.status).toBe('unexpected');
	// Nothing is inferred from the stem and nothing is migrated.
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toBe(old);
	const listed = expectOk(await folder.tables.recordings.list());
	expect(listed.entries[0]!.issues).toEqual([
		{ kind: 'field', field: 'audioPath', message: 'The field is missing' },
	]);
	await folder.close();
});

test('this recording’s row without its audio refuses and writes nothing', async () => {
	const { root, folder } = await open();
	const pending = capture();
	expect((await publishRecording(folder, pending)).status).toBe('saved');
	await rm(join(root, pending.fields.audioPath));

	const outcome = await publishRecording(folder, pending);

	expect(outcome.status).toBe('unexpected');
	if (outcome.status === 'unexpected') {
		expect(outcome.path).toBe(pending.fields.audioPath);
		expect(outcome.message).toContain('is not in the folder');
	}
	expect(await names(root)).toEqual([`${pending.id}.md`]);
	await folder.close();
});

// ============================================================================
// Unknown outcomes
// ============================================================================

test('a lost publication reply is not success, and the retry recognizes what landed', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const lossy: PublishTarget = {
		...folder,
		async batch(collect) {
			const result = await folder.batch(collect);
			return result.error
				? result
				: FileError.Unconfirmed({
						path: 'batch',
						operation: 'batch',
						cause: 'reply lost after publication',
					});
		},
	};

	const first = await publishRecording(lossy, pending);

	expect(first.status).toBe('failed');
	const landed = await readFile(
		join(root, 'recordings', `${pending.id}.md`),
		'utf8',
	);

	const retry = await publishRecording(folder, pending);

	expect(retry.status).toBe('saved');
	if (retry.status === 'saved') expect(retry.recovered).toBe(true);
	expect(await names(root)).toEqual([`${pending.id}.md`, `${pending.id}.wav`]);
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toBe(landed);
	await folder.close();
});

// ============================================================================
// A confirmed publication whose row cannot then be shown
// ============================================================================

test('a row that cannot be read back after a confirmed publication is published, not failed', async () => {
	const { root, folder } = await open();
	const pending = capture();
	let reads = 0;
	const unreadable: PublishTarget = {
		...folder,
		tables: {
			recordings: {
				// The first read finds no row. The read after the batch fails.
				get: (stem) =>
					++reads === 1
						? folder.tables.recordings.get(stem)
						: Promise.resolve(
								FileError.Io({
									path: `recordings/${stem}.md`,
									operation: 'read',
									cause: new Error('host unreachable'),
								}),
							),
			},
		},
	};

	const first = await publishRecording(unreadable, pending);

	// The receipt proves the save. The failed read is about what can be shown.
	expect(first.status).toBe('published');
	if (first.status !== 'published') return;
	expect(first.problem.status).toBe('unreadable');
	expect(first.problem.message).toContain('host unreachable');
	expect(reads).toBe(2);
	// The receipt's captures are of the bytes that were submitted, exactly.
	expect(first.publication.audio).toEqual({
		path: pending.fields.audioPath,
		version: await captureVersion(pending.bytes),
	});
	expect(first.publication.row).toEqual({
		path: `recordings/${pending.id}.md`,
		version: await captureVersion(
			await bytesAt(root, 'recordings', `${pending.id}.md`),
		),
	});
	expect(await bytesAt(root, 'recordings', `${pending.id}.wav`)).toEqual(
		new Uint8Array(pending.bytes),
	);
	// No entry is invented from the receipt.
	expect('entry' in first).toBe(false);
	expect(pending).toEqual(capture());

	// Looking again only reads, and finds the row as the folder has it.
	const observed = await observePublication(folder, pending);
	expect(observed.status).toBe('present');
	if (observed.status === 'present')
		expect(observed.entry.fields).toEqual(pending.fields);
	expect(await names(root)).toEqual([`${pending.id}.md`, `${pending.id}.wav`]);
	await folder.close();
});

test('a row another writer replaced right after publication is still a publication, and is left as found', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const foreign = '---\ntitle: Someone else\n---\nKeep me\n';
	let reads = 0;
	const raced: PublishTarget = {
		...folder,
		tables: {
			recordings: {
				async get(stem) {
					// Before the read-back, another writer replaces the row.
					if (++reads === 2)
						expectOk(
							await folder.files.overwrite(`recordings/${stem}.md`, foreign),
						);
					return folder.tables.recordings.get(stem);
				},
			},
		},
	};

	const outcome = await publishRecording(raced, pending);

	expect(outcome.status).toBe('published');
	if (outcome.status === 'published')
		expect(outcome.problem.status).toBe('foreign');
	expect((await observePublication(folder, pending)).status).toBe('foreign');
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toBe(foreign);
	await folder.close();
});

test('a row another writer removed right after publication is still a publication, and is not recreated', async () => {
	const { root, folder } = await open();
	const pending = capture();
	let reads = 0;
	const raced: PublishTarget = {
		...folder,
		tables: {
			recordings: {
				async get(stem) {
					if (++reads === 2) await rm(join(root, 'recordings', `${stem}.md`));
					return folder.tables.recordings.get(stem);
				},
			},
		},
	};

	const outcome = await publishRecording(raced, pending);

	expect(outcome.status).toBe('published');
	if (outcome.status === 'published')
		expect(outcome.problem.status).toBe('missing');
	expect((await observePublication(folder, pending)).status).toBe('missing');
	// Observing wrote nothing: only the audio is there.
	expect(await names(root)).toEqual([`${pending.id}.wav`]);
	await folder.close();
});

test('observing a published recording whose title and notes were edited returns the current row', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const first = await publishRecording(folder, pending);
	if (first.status !== 'saved') throw new Error('expected the capture saved');
	const edited = expectOk(
		await folder.tables.recordings.update(first.entry, {
			fields: { title: 'Renamed' },
			body: 'Notes written later\n',
		}),
	);
	const before = await readFile(
		join(root, 'recordings', `${pending.id}.md`),
		'utf8',
	);

	const observed = await observePublication(folder, pending);

	// An edit is not evidence of a failed save: this is the recording, as it is now.
	expect(observed.status).toBe('present');
	if (observed.status !== 'present') return;
	expect(observed.entry.version).toEqual(edited.version);
	expect(observed.entry.fields.title).toBe('Renamed');
	expect(observed.entry.body).toBe('Notes written later\n');
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toBe(before);
	await folder.close();
});
