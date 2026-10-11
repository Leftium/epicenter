/**
 * Recording Publication Tests
 *
 * Publication and recovery against a real directory and a real Git
 * repository, as two independent folder writes. Failures are real: a
 * directory placed where one write goes makes the folder refuse that write
 * itself.
 *
 * Key behaviors:
 * - A capture is saved as its audio, then a row that names it in `audioPath`;
 *   each write's receipt describes exactly the bytes it was given
 * - Audio that landed without its row stays, and a retry under the same id
 *   reads both paths and creates only the row; it never rewrites the audio
 * - A retry of a published capture writes nothing and reports what it found
 * - Foreign audio, same-size changed audio, a foreign row, and a row without
 *   its audio all refuse and are left as found
 * - A file that only shares the stem is not the recording's and blocks nothing
 * - A lost reply is unknown, never success; a retry recognizes what is there
 *   as found, not as the confirmation of that earlier write
 * - The debug hook surrounds each write that is made, and no other
 */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileError, hashBytes } from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';
import { toneWav } from '../capture.js';
import type { RecordingFields } from '../definition.js';
import type { RecordingWrite } from '../workspace/types.js';
import {
	openTestFolder,
	recordingWriteFailures,
} from '../workspace.test-support.js';
import {
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

/** The folder, counting every write publication could make. */
function counted(target: PublishTarget) {
	const writes: string[] = [];
	const counting: PublishTarget = {
		files: {
			read: (path) => target.files.read(path),
			create(path, content) {
				writes.push(path);
				return target.files.create(path, content);
			},
		},
		tables: {
			recordings: {
				get: (stem) => target.tables.recordings.get(stem),
				create(row, options) {
					writes.push(`recordings/${options?.stem}.md`);
					return target.tables.recordings.create(row, options);
				},
			},
		},
	};
	return { writes, counting };
}

// ============================================================================
// Publication
// ============================================================================

test('a capture is saved as audio and a row that names it, then committed and restorable with Git', async () => {
	const { root, folder } = await open();
	const pending = capture();

	const outcome = await publishRecording(folder, pending, { retry: false });

	expect(outcome.kind).toBe('published');
	if (outcome.kind !== 'published') return;
	// Each receipt is of the bytes its write was given.
	expect(outcome.audio).toEqual({
		by: 'receipt',
		file: {
			path: pending.fields.audioPath,
			sha256: await hashBytes(pending.bytes),
		},
	});
	expect(outcome.row).toEqual({
		by: 'receipt',
		file: {
			path: `recordings/${pending.id}.md`,
			sha256: await hashBytes(
				await bytesAt(root, 'recordings', `${pending.id}.md`),
			),
		},
	});
	const row = expectOk(await folder.tables.recordings.get(pending.id));
	expect(row?.row).toEqual({ fields: pending.fields, body: pending.body });
	expect(await names(root)).toEqual([`${pending.id}.md`, `${pending.id}.wav`]);
	// The stored audio is the captured bytes, exactly.
	expect(await bytesAt(root, 'recordings', `${pending.id}.wav`)).toEqual(
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
	const committedRow = git(root, 'show', `HEAD:recordings/${pending.id}.md`);
	expect(committedRow).toContain('title: First take');
	expect(committedRow).toContain(`audioPath: recordings/${pending.id}.wav`);
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
	).toBe(committedRow);
});

test('a file that only shares the stem is not the recording’s and does not block it', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const sibling = new Uint8Array([9, 9, 9]);
	expectOk(await folder.files.create(`recordings/${pending.id}.m4a`, sibling));
	expectOk(await folder.files.create(`recordings/${pending.id}.txt`, 'note'));

	expect((await publishRecording(folder, pending, { retry: false })).kind).toBe(
		'published',
	);
	// A retry reads only the two paths the capture names.
	expect((await publishRecording(folder, pending, { retry: true })).kind).toBe(
		'published',
	);

	expect(
		expectOk(await folder.tables.recordings.get(pending.id))?.row.fields
			.audioPath,
	).toBe(`recordings/${pending.id}.wav`);
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
// A row that did not land, and recovery
// ============================================================================

test('a row that fails after the audio landed leaves the audio, and a retry creates only the row under the same id', async () => {
	const { root, folder } = await open();
	const pending = capture();
	// Twice, a directory is in the way where the row is written: the folder
	// refuses that write itself, after the audio write already succeeded.
	const around = recordingWriteFailures(root, { audio: 0, row: 2 });
	const { writes, counting } = counted(folder);

	const first = await publishRecording(counting, pending, {
		retry: false,
		around,
	});

	expect(first).toMatchObject({
		kind: 'rowNotSaved',
		certainty: 'failed',
		audio: {
			by: 'receipt',
			file: {
				path: pending.fields.audioPath,
				sha256: await hashBytes(pending.bytes),
			},
		},
	});
	expect(await names(root)).toEqual([`${pending.id}.wav`]);
	expect(await bytesAt(root, 'recordings', `${pending.id}.wav`)).toEqual(
		new Uint8Array(pending.bytes),
	);
	// The capture is what it was: nothing about it changed by failing.
	expect(pending).toEqual(capture());
	expect(writes).toEqual([
		pending.fields.audioPath,
		`recordings/${pending.id}.md`,
	]);

	// Still obstructed. The retry finds the audio and creates only the row; the
	// audio is never written again.
	const second = await publishRecording(counting, pending, {
		retry: true,
		around,
	});
	expect(second).toMatchObject({
		kind: 'rowNotSaved',
		certainty: 'failed',
		audio: { by: 'found' },
	});
	expect(writes.slice(2)).toEqual([`recordings/${pending.id}.md`]);
	expect(await names(root)).toEqual([`${pending.id}.wav`]);

	const third = await publishRecording(counting, pending, {
		retry: true,
		around,
	});

	expect(third).toMatchObject({
		kind: 'published',
		audio: { by: 'found' },
		row: { by: 'receipt' },
	});
	expect(writes.slice(3)).toEqual([`recordings/${pending.id}.md`]);
	expect(
		expectOk(await folder.tables.recordings.get(pending.id))?.row.fields,
	).toEqual(pending.fields);
	expect(await names(root)).toEqual([`${pending.id}.md`, `${pending.id}.wav`]);
	expect(await bytesAt(root, 'recordings', `${pending.id}.wav`)).toEqual(
		new Uint8Array(pending.bytes),
	);
	// A save is not a commit: history is asked for separately and holds both files.
	expect((await folder.git.commit()).status).not.toBe('failed');
	expect(
		git(root, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n').sort(),
	).toEqual([
		'epicenter.json',
		`recordings/${pending.id}.md`,
		`recordings/${pending.id}.wav`,
	]);
	await folder.close();
});

test('audio that fails first leaves nothing in the folder and no row is attempted; a retry saves both', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const around = recordingWriteFailures(root, { audio: 1, row: 0 });
	const { writes, counting } = counted(folder);

	const first = await publishRecording(counting, pending, {
		retry: false,
		around,
	});

	// The folder refused the create itself: a directory is where the audio goes.
	expect(first).toMatchObject({
		kind: 'audioNotSaved',
		certainty: 'failed',
		message: expect.stringContaining('is a directory'),
	});
	expect(writes).toEqual([pending.fields.audioPath]);
	expect(await names(root)).toEqual([]);

	const second = await publishRecording(counting, pending, {
		retry: true,
		around,
	});
	expect(second).toMatchObject({
		kind: 'published',
		audio: { by: 'receipt' },
		row: { by: 'receipt' },
	});
	expect(await names(root)).toEqual([`${pending.id}.md`, `${pending.id}.wav`]);
	await folder.close();
});

test('retrying a published capture writes nothing and reports both files as found', async () => {
	const { root, folder } = await open();
	const pending = capture();
	expect((await publishRecording(folder, pending, { retry: false })).kind).toBe(
		'published',
	);
	const before = await readFile(
		join(root, 'recordings', `${pending.id}.md`),
		'utf8',
	);
	const { writes, counting } = counted(folder);

	const again = await publishRecording(counting, pending, { retry: true });

	expect(again).toMatchObject({
		kind: 'published',
		audio: { by: 'found' },
		row: { by: 'found' },
	});
	expect(writes).toEqual([]);
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toBe(before);
	expect(await names(root)).toHaveLength(2);
	await folder.close();
});

test('a published recording whose title was edited since is still this recording', async () => {
	const { root, folder } = await open();
	const pending = capture();
	await publishRecording(folder, pending, { retry: false });
	const stored = expectOk(await folder.tables.recordings.get(pending.id))!;
	expectOk(
		await folder.tables.recordings.replace(stored, {
			...stored.row,
			fields: { ...stored.row.fields, title: 'Renamed by its owner' },
		}),
	);

	const again = await publishRecording(folder, pending, { retry: true });

	expect(again.kind).toBe('published');
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

test('audio it did not write is never replaced, on a first attempt or a retry', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const other = new Uint8Array([1, 2, 3, 4]);
	expectOk(await folder.files.create(pending.fields.audioPath, other));

	for (const retry of [false, true]) {
		const outcome = await publishRecording(folder, pending, { retry });
		expect(outcome).toMatchObject({
			kind: 'refused',
			path: pending.fields.audioPath,
		});
	}
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

	const outcome = await publishRecording(folder, pending, { retry: true });

	expect(outcome).toMatchObject({
		kind: 'refused',
		path: pending.fields.audioPath,
	});
	expect(await names(root)).toEqual([`${pending.id}.wav`]);
	expect(await bytesAt(root, 'recordings', `${pending.id}.wav`)).toEqual(other);
	await folder.close();
});

test('audio changed after a retry read it is not rewritten: independent writes cannot hold it still', async () => {
	const { root, folder } = await open();
	const pending = capture();
	expectOk(await folder.files.create(pending.fields.audioPath, pending.bytes));
	const other = new Uint8Array(toneWav({ frequency: 880 }));
	// Another writer saves over the audio right after this attempt read it.
	const raced: PublishTarget = {
		...folder,
		files: {
			create: (path, content) => folder.files.create(path, content),
			async read(path) {
				const read = await folder.files.read(path);
				const { error: readError } = read;
				if (readError === null)
					expectOk(await folder.files.overwrite(path, other));
				return read;
			},
		},
	};

	const outcome = await publishRecording(raced, pending, { retry: true });

	// The row is created beside the audio the retry recognized. Nothing writes
	// the audio again to imitate a condition across the two files, so the
	// other writer's bytes are what is there; the person sees them in the row.
	expect(outcome).toMatchObject({
		kind: 'published',
		audio: { by: 'found' },
		row: { by: 'receipt' },
	});
	expect(await bytesAt(root, 'recordings', `${pending.id}.wav`)).toEqual(other);
	await folder.close();
});

test('a row it did not write is never replaced', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const foreign = '---\ntitle: Someone else\n---\nKeep me\n';
	expectOk(await folder.files.create(`recordings/${pending.id}.md`, foreign));

	// A first attempt reads nothing first: its audio lands, and the exclusive
	// row create is refused by the folder.
	const first = await publishRecording(folder, pending, { retry: false });
	expect(first).toMatchObject({
		kind: 'rowNotSaved',
		certainty: 'failed',
		audio: { by: 'receipt' },
	});
	if (first.kind === 'rowNotSaved')
		expect(first.message).toContain('already exists');

	// A retry reads the row first and refuses before writing anything.
	const retry = await publishRecording(folder, pending, { retry: true });
	expect(retry).toMatchObject({
		kind: 'refused',
		path: `recordings/${pending.id}.md`,
	});
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toBe(foreign);
	expect(await names(root)).toEqual([`${pending.id}.md`, `${pending.id}.wav`]);
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

	const outcome = await publishRecording(folder, pending, { retry: true });

	expect(outcome.kind).toBe('refused');
	// Nothing is inferred from the stem and nothing is migrated.
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toBe(old);
	const listed = expectOk(await folder.tables.recordings.list());
	const { error } = listed[0]!.result;
	expect(
		error?.name === 'InvalidRow' && error.issues.map((issue) => issue.field),
	).toEqual(['audioPath']);
	await folder.close();
});

test('this recording’s row without its audio refuses and writes nothing', async () => {
	const { root, folder } = await open();
	const pending = capture();
	await publishRecording(folder, pending, { retry: false });
	await rm(join(root, pending.fields.audioPath));
	const { writes, counting } = counted(folder);

	const outcome = await publishRecording(counting, pending, { retry: true });

	expect(outcome).toMatchObject({
		kind: 'refused',
		path: pending.fields.audioPath,
	});
	if (outcome.kind === 'refused')
		expect(outcome.message).toContain('is not in the folder');
	expect(writes).toEqual([]);
	expect(await names(root)).toEqual([`${pending.id}.md`]);
	await folder.close();
});

test('a retry that cannot read the folder writes nothing', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const unreadable: PublishTarget = {
		...folder,
		tables: {
			recordings: {
				create: (input) => folder.tables.recordings.create(input),
				get: (stem) =>
					Promise.resolve(
						FileError.Io({
							path: `recordings/${stem}.md`,
							operation: 'read',
							cause: new Error('host unreachable'),
						}),
					),
			},
		},
	};

	const outcome = await publishRecording(unreadable, pending, { retry: true });

	expect(outcome.kind).toBe('unchecked');
	if (outcome.kind === 'unchecked')
		expect(outcome.message).toContain('host unreachable');
	expect(await readdir(root)).not.toContain('recordings');
	await folder.close();
});

// ============================================================================
// Unknown outcomes
// ============================================================================

/** A folder whose next reply to `path` is lost after the write landed. */
function losing(target: PublishTarget, lose: 'audio' | 'row'): PublishTarget {
	const lost = (path: string, operation: string) =>
		FileError.Unconfirmed({ path, operation, cause: 'reply lost' });
	return {
		files: {
			read: (path) => target.files.read(path),
			async create(path, content) {
				const created = await target.files.create(path, content);
				const { error: createError } = created;
				return lose === 'audio' && createError === null
					? lost(path, 'create')
					: created;
			},
		},
		tables: {
			recordings: {
				get: (stem) => target.tables.recordings.get(stem),
				async create(row, options) {
					const created = await target.tables.recordings.create(row, options);
					const { data: stored, error: createError } = created;
					return lose === 'row' && createError === null
						? lost(stored.path, 'create')
						: created;
				},
			},
		},
	};
}

test('a lost audio reply is unknown and the row is not attempted; the retry finds the audio and creates the row', async () => {
	const { root, folder } = await open();
	const pending = capture();

	const first = await publishRecording(losing(folder, 'audio'), pending, {
		retry: false,
	});

	expect(first).toMatchObject({ kind: 'audioNotSaved', certainty: 'unknown' });
	expect(await names(root)).toEqual([`${pending.id}.wav`]);

	const retry = await publishRecording(folder, pending, { retry: true });

	// What the retry found is not attributed to the lost write.
	expect(retry).toMatchObject({
		kind: 'published',
		audio: { by: 'found' },
		row: { by: 'receipt' },
	});
	expect(await names(root)).toEqual([`${pending.id}.md`, `${pending.id}.wav`]);
	await folder.close();
});

test('a lost row reply is unknown, and the retry reports the row it finds as found, never as that write’s receipt', async () => {
	const { root, folder } = await open();
	const pending = capture();

	const first = await publishRecording(losing(folder, 'row'), pending, {
		retry: false,
	});

	expect(first).toMatchObject({
		kind: 'rowNotSaved',
		certainty: 'unknown',
		audio: { by: 'receipt' },
	});
	const landed = await readFile(
		join(root, 'recordings', `${pending.id}.md`),
		'utf8',
	);
	const { writes, counting } = counted(folder);

	const retry = await publishRecording(counting, pending, { retry: true });

	expect(retry).toMatchObject({
		kind: 'published',
		audio: { by: 'found' },
		row: { by: 'found' },
	});
	expect(writes).toEqual([]);
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toBe(landed);
	await folder.close();
});

test('a write that throws is an unknown outcome, and what was known before it is kept', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const throwing: PublishTarget = {
		...folder,
		tables: {
			recordings: {
				get: (stem) => folder.tables.recordings.get(stem),
				create: () => Promise.reject(new Error('the folder host went away')),
			},
		},
	};

	const outcome = await publishRecording(throwing, pending, { retry: false });

	expect(outcome).toMatchObject({
		kind: 'rowNotSaved',
		certainty: 'unknown',
		audio: { by: 'receipt' },
		message: 'the folder host went away',
	});
	expect(await names(root)).toEqual([`${pending.id}.wav`]);
	await folder.close();
});

// ============================================================================
// An earlier write landing after the attempt looked
// ============================================================================

/**
 * The folder, where something lands at `path` just before the attempt's own
 * create there: as an earlier write of this capture whose reply was lost may
 * land late, or another writer's file may.
 */
function landingBefore(
	folder: PublishTarget,
	path: string,
	land: () => Promise<unknown>,
): PublishTarget {
	return {
		files: {
			read: (target) => folder.files.read(target),
			async create(target, content) {
				if (target === path) await land();
				return folder.files.create(target, content);
			},
		},
		tables: {
			recordings: {
				get: (stem) => folder.tables.recordings.get(stem),
				async create(row, options) {
					if (`recordings/${options?.stem}.md` === path) await land();
					return folder.tables.recordings.create(row, options);
				},
			},
		},
	};
}

test('audio that lands late from an earlier write of this capture is read and found, and the row is created', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const raced = landingBefore(folder, pending.fields.audioPath, () =>
		folder.files.create(pending.fields.audioPath, pending.bytes),
	);

	// The retry reads the path as empty, then its create finds it occupied.
	const outcome = await publishRecording(raced, pending, { retry: true });

	expect(outcome).toMatchObject({
		kind: 'published',
		audio: {
			by: 'found',
			file: {
				path: pending.fields.audioPath,
				sha256: await hashBytes(pending.bytes),
			},
		},
		row: { by: 'receipt' },
	});
	expect(await names(root)).toEqual([`${pending.id}.md`, `${pending.id}.wav`]);
	await folder.close();
});

test('other audio that lands before the create is read, called another writer’s, and left alone', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const other = new Uint8Array(toneWav({ frequency: 880 }));
	const raced = landingBefore(folder, pending.fields.audioPath, () =>
		folder.files.create(pending.fields.audioPath, other),
	);

	const outcome = await publishRecording(raced, pending, { retry: true });

	expect(outcome).toMatchObject({
		kind: 'refused',
		path: pending.fields.audioPath,
	});
	expect(await bytesAt(root, 'recordings', `${pending.id}.wav`)).toEqual(other);
	expect(await names(root)).toEqual([`${pending.id}.wav`]);
	await folder.close();
});

test('an occupied audio path that cannot then be read stays unknown, never called another writer’s', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const landed = landingBefore(folder, pending.fields.audioPath, () =>
		folder.files.create(pending.fields.audioPath, pending.bytes),
	);
	let reads = 0;
	const raced: PublishTarget = {
		...landed,
		files: {
			...landed.files,
			// The retry's own look reads it as absent; the read after the refusal fails.
			read: async (path) =>
				++reads === 1
					? folder.files.read(path)
					: FileError.Io({
							path,
							operation: 'read',
							cause: new Error('host unreachable'),
						}),
		},
	};

	const outcome = await publishRecording(raced, pending, { retry: true });

	expect(outcome).toMatchObject({
		kind: 'audioNotSaved',
		certainty: 'unknown',
	});
	if (outcome.kind === 'audioNotSaved')
		expect(outcome.message).toContain('is not known');
	// The audio that is there stays, and nothing else was written.
	expect(await names(root)).toEqual([`${pending.id}.wav`]);
	await folder.close();
});

test('this recording’s row that lands late is read and found, never written over', async () => {
	const { root, folder } = await open();
	const pending = capture();
	expectOk(await folder.files.create(pending.fields.audioPath, pending.bytes));
	const raced = landingBefore(folder, `recordings/${pending.id}.md`, () =>
		folder.tables.recordings.create(
			{ fields: { ...pending.fields }, body: 'Notes written since\n' },
			{ stem: pending.id },
		),
	);

	const outcome = await publishRecording(raced, pending, { retry: true });

	expect(outcome).toMatchObject({
		kind: 'published',
		audio: { by: 'found' },
		row: { by: 'found' },
	});
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toContain('Notes written since');
	await folder.close();
});

// ============================================================================
// The debug write hook
// ============================================================================

test('the hook surrounds each write that is made, and is not reached for a write that is not', async () => {
	const { root, folder } = await open();
	const pending = capture();
	const seen: { write: RecordingWrite; rows: string[] }[] = [];
	const failing = recordingWriteFailures(root, { audio: 0, row: 1 });
	const around: Parameters<typeof publishRecording>[2]['around'] = async (
		write,
		run,
	) => {
		// The write has not run yet when the hook is entered.
		seen.push({
			write,
			rows: (
				await readdir(join(root, 'recordings')).catch(() => [] as string[])
			).filter((name) => name.endsWith('.md')),
		});
		return failing(write, run);
	};

	// A new recording: the audio write, then the row write, which fails.
	expect(
		(await publishRecording(folder, pending, { retry: false, around })).kind,
	).toBe('rowNotSaved');
	// A retry: the audio is already there, so only the row is written.
	expect(
		(await publishRecording(folder, pending, { retry: true, around })).kind,
	).toBe('published');
	// Already published: nothing is written, so the hook is not reached.
	expect(
		(await publishRecording(folder, pending, { retry: true, around })).kind,
	).toBe('published');

	expect(seen).toEqual([
		{
			write: {
				step: 'audio',
				stem: pending.id,
				path: pending.fields.audioPath,
			},
			rows: [],
		},
		{ write: { step: 'row', stem: pending.id }, rows: [] },
		{ write: { step: 'row', stem: pending.id }, rows: [] },
	]);
	expect(await names(root)).toEqual([`${pending.id}.md`, `${pending.id}.wav`]);
	await folder.close();
});
