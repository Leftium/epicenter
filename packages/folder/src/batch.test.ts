/**
 * Batch Tests
 *
 * `folder.batch` runs a synchronous callback once, collects the mutations it
 * names, and publishes them through one application of the file boundary and
 * one history request. These cases run against a browser folder, where the
 * batch is one transaction, and a directory folder, where it is ordered steps.
 *
 * Key behaviors:
 * - The callback runs exactly once; a throw, a returned promise, or any other
 *   returned value publishes nothing
 * - The collector is sealed when the callback returns: keeping it, or using
 *   it after an await, throws and publishes nothing
 * - Bytes are copied when a mutation is collected
 * - A typed row is created at the caller's stem with the same source a
 *   standalone create writes; an invalid one refuses the whole batch
 * - The receipt's captures come from the collected bytes, not from the folder
 * - A browser batch lands whole or not at all; a directory batch reports
 *   `Partial` with the steps that landed and requests no commit
 * - Recovery after `Partial`: replace the observed audio and create the row
 *   in one more batch
 *
 * See also:
 * - `tauri.test.ts` for the batch as the desktop owner receives it
 * - `files.test.ts` for the same verbs one at a time
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from 'bun:test';
import { mkdir, readdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder as openBrowserFolder } from './browser.js';
import {
	defineFolder,
	defineTable,
	type Folder,
	type FolderBatch,
	field,
} from './contract.js';
import { openNativeFolder } from './directory.test-support.js';
import { GIT_ENV, git, scratch } from './git-http.test-support.js';
import { captureVersion } from './version.js';

const definition = defineFolder({
	id: 'so.epicenter.batchtest',
	kv: {},
	tables: {
		recordings: defineTable({
			fields: { title: field.string(), audioPath: field.string() },
		}),
	},
});
type Opened = Folder<typeof definition>;
type Collector = FolderBatch<typeof definition>;

const author = { name: 'Batch', email: 'batch@example.test' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const AUDIO = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
const recording = (stem: string) => ({
	stem,
	fields: { title: stem, audioPath: `audio/${stem}.webm` },
	body: 'Transcript.\n',
});
const rowSource = (stem: string) =>
	`---\ntitle: ${stem}\naudioPath: audio/${stem}.webm\n---\nTranscript.\n`;

const originalEnv = { ...process.env };
beforeAll(() => {
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});

const opened: Opened[] = [];
afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
});

async function openBrowser(commitOnEdit = false) {
	const folder = expectOk(
		await openBrowserFolder({
			definition,
			browser: {
				author,
				commitOnEdit,
				indexedDb: { indexedDB: new IDBFactory(), IDBKeyRange },
			},
		}),
	);
	opened.push(folder);
	return folder;
}
async function openDirectory(commitOnEdit = false) {
	const root = await scratch('batch-');
	const folder = await openNativeFolder({
		root,
		definition,
		git: { author, commitOnEdit },
	});
	opened.push(folder);
	return { folder, root };
}

async function settled(folder: Opened) {
	for (let index = 0; index < 400; index++) {
		const { commit } = folder.git.snapshot.activity;
		if (!commit.active && !commit.pending) return;
		await Bun.sleep(5);
	}
	throw new Error('Git work did not settle');
}
const paths = async (folder: Opened) =>
	expectOk(await folder.files.list()).files.map((file) => file.path);

describe.each(['browser', 'directory'])('%s folder batch', (kind) => {
	const open = async (commitOnEdit = false) =>
		kind === 'browser'
			? openBrowser(commitOnEdit)
			: (await openDirectory(commitOnEdit)).folder;

	test('audio and its typed row publish together: one history request, ordered receipt, captures from the collected bytes', async () => {
		const folder = await open(true);
		let calls = 0;

		const receipt = expectOk(
			await folder.batch((batch) => {
				calls++;
				batch.files.create('audio/take.webm', AUDIO);
				batch.tables.recordings.create(recording('take'));
			}),
		);
		await settled(folder);

		expect(calls).toBe(1);
		expect(receipt.steps).toEqual([
			{
				kind: 'write',
				path: 'audio/take.webm',
				file: {
					path: 'audio/take.webm',
					version: await captureVersion(AUDIO),
				},
			},
			{
				kind: 'write',
				path: 'recordings/take.md',
				file: {
					path: 'recordings/take.md',
					version: await captureVersion(encoder.encode(rowSource('take'))),
				},
			},
		]);
		expect(Object.isFrozen(receipt) && Object.isFrozen(receipt.steps)).toBe(
			true,
		);
		// Both files are in one commit: the save asked history once.
		const log = expectOk(await folder.git.log(10));
		expect(log.map((commit) => commit.message.trim())).toEqual([
			'Update 2 files',
		]);

		// The collector writes the row a standalone create would have written.
		const row = expectOk(await folder.tables.recordings.get('take'));
		expect(row?.source).toBe(rowSource('take'));
		expect(row?.issues).toBeUndefined();
		const alone = expectOk(
			await folder.tables.recordings.create(recording('alone')),
		);
		expect(alone.source).toBe(rowSource('alone'));
		// The receipt's capture is a working baseline for the row.
		const step = receipt.steps[1];
		if (step?.kind !== 'write' || row === undefined)
			throw new Error('expected the row write');
		expect(step.file.version).toEqual(row.version);
	});

	test('every file verb is an intent: conditions hold, a removal leaves no capture, a move keeps its baseline', async () => {
		const folder = await open();
		const draft = expectOk(await folder.files.create('draft.md', 'v1'));
		const old = expectOk(await folder.files.create('old.bin', 'old'));
		const loose = expectOk(await folder.files.create('loose.txt', 'loose'));

		const receipt = expectOk(
			await folder.batch((batch) => {
				batch.files.replace(draft, 'v2');
				batch.files.move(old, 'kept/old.bin');
				batch.files.remove(loose);
				batch.files.overwrite('settings.txt', 'on');
			}),
		);

		expect(receipt.steps).toEqual([
			{
				kind: 'write',
				path: 'draft.md',
				file: {
					path: 'draft.md',
					version: await captureVersion(encoder.encode('v2')),
				},
			},
			{
				kind: 'move',
				from: 'old.bin',
				to: 'kept/old.bin',
				file: { path: 'kept/old.bin', version: old.version },
			},
			{ kind: 'remove', path: 'loose.txt' },
			{
				kind: 'write',
				path: 'settings.txt',
				file: {
					path: 'settings.txt',
					version: await captureVersion(encoder.encode('on')),
				},
			},
		]);
		expect((await paths(folder)).sort()).toEqual([
			'draft.md',
			'kept/old.bin',
			'settings.txt',
		]);
	});

	test('bytes are copied when a mutation is collected, not when the batch publishes', async () => {
		const folder = await open();
		const audio = new Uint8Array(AUDIO);
		const publishing = folder.batch((batch) => {
			batch.files.create('audio/take.webm', audio);
			// Still inside the callback, right after the intent was collected.
			audio.fill(0);
			batch.files.create('audio/zeros.webm', audio);
		});
		audio.fill(255);
		const receipt = expectOk(await publishing);

		expect(expectOk(await folder.files.read('audio/take.webm')).bytes).toEqual(
			AUDIO,
		);
		expect(expectOk(await folder.files.read('audio/zeros.webm')).bytes).toEqual(
			new Uint8Array(AUDIO.length),
		);
		const first = receipt.steps[0];
		expect(first?.kind === 'write' && first.file.version).toEqual(
			await captureVersion(AUDIO),
		);
	});

	test('a callback that throws, returns a promise, or returns a value publishes nothing', async () => {
		const folder = await open(true);
		let calls = 0;
		const collectThen = (after: () => unknown) => (batch: Collector) => {
			calls++;
			batch.files.create('audio/take.webm', AUDIO);
			batch.tables.recordings.create(recording('take'));
			return after() as undefined;
		};

		const threw = expectErr(
			await folder.batch(
				collectThen(() => {
					throw new Error('recorder failed');
				}),
			),
		);
		expect(threw).toMatchObject({ name: 'Threw' });
		expect(threw.message).toContain('recorder failed');

		const promised = expectErr(
			await folder.batch(collectThen(() => Promise.resolve())),
		);
		expect(promised).toMatchObject({ name: 'Returned', thenable: true });
		const thenable = expectErr(
			// biome-ignore lint/suspicious/noThenProperty: a hand-made thenable is what this refuses.
			await folder.batch(collectThen(() => ({ then() {} }))),
		);
		expect(thenable).toMatchObject({ name: 'Returned', thenable: true });
		const valued = expectErr(await folder.batch(collectThen(() => 1)));
		expect(valued).toMatchObject({ name: 'Returned', thenable: false });

		// Each callback ran once, and none of them published or asked history.
		expect(calls).toBe(4);
		await settled(folder);
		expect(await paths(folder)).toEqual([]);
		expect(folder.git.snapshot.lastCommit).toBeUndefined();
	});

	test('the collector is sealed when the callback returns: a kept one, or one used after an await, throws and publishes nothing', async () => {
		const folder = await open();
		let kept: Collector | undefined;
		expectOk(
			await folder.batch((batch) => {
				kept = batch;
				batch.files.create('first.txt', 'first');
			}),
		);
		if (kept === undefined) throw new Error('the callback did not run');
		const retained = kept;
		for (const use of [
			() => retained.files.create('late.txt', 'late'),
			() => retained.files.overwrite('first.txt', 'changed'),
			() => retained.tables.recordings.create(recording('late')),
		])
			expect(use).toThrow('This batch is sealed');

		// An async callback is refused, and what it does after its await fails
		// inside its own promise without reaching the folder.
		let afterAwait: unknown;
		const refused = expectErr(
			await folder.batch((async (batch: Collector) => {
				await Promise.resolve();
				try {
					batch.files.create('async.txt', 'async');
				} catch (cause) {
					afterAwait = cause;
					throw cause;
				}
			}) as unknown as (batch: Collector) => undefined),
		);
		expect(refused).toMatchObject({ name: 'Returned', thenable: true });
		await Bun.sleep(5);
		expect(String(afterAwait)).toContain('This batch is sealed');
		expect(await paths(folder)).toEqual(['first.txt']);
		expect(
			decoder.decode(expectOk(await folder.files.read('first.txt')).bytes),
		).toBe('first');
	});

	test('an invalid row, path, or capture refuses the whole batch before anything is published', async () => {
		const folder = await open();
		const refusals = [
			await folder.batch((batch) => {
				batch.files.create('audio/a.webm', AUDIO);
				batch.tables.recordings.create({
					stem: 'a',
					fields: { title: 1 as unknown as string, audioPath: 'audio/a.webm' },
				});
			}),
			await folder.batch((batch) => {
				batch.files.create('audio/a.webm', AUDIO);
				batch.tables.recordings.create({
					...recording('a'),
					stem: '../a',
				});
			}),
			await folder.batch((batch) => {
				batch.files.create('audio/a.webm', AUDIO);
				batch.tables.recordings.create(
					// A batch reads nothing, so it cannot choose an unused stem.
					{ fields: recording('a').fields } as never,
				);
			}),
			await folder.batch((batch) => {
				batch.files.create('audio/a.webm', AUDIO);
				batch.files.create('../outside.webm', AUDIO);
			}),
			await folder.batch((batch) => {
				batch.files.create('audio/a.webm', AUDIO);
				batch.files.replace({ path: 'audio/b.webm' } as never, AUDIO);
			}),
		];
		expect(refusals.map((refused) => expectErr(refused).name)).toEqual([
			'InvalidValues',
			'InvalidStem',
			'InvalidStem',
			'InvalidPath',
			'InvalidPath',
		]);
		expect(await paths(folder)).toEqual([]);

		// An empty batch is a successful nothing.
		expect(expectOk(await folder.batch(() => undefined)).steps).toEqual([]);
	});

	test('the receipt describes what this batch saved; a later read is a separate observation', async () => {
		const folder = await open();
		const receipt = expectOk(
			await folder.batch((batch) => {
				batch.files.create('audio/take.webm', AUDIO);
				batch.tables.recordings.create(recording('take'));
			}),
		);
		// Another writer replaces both files after the batch was acknowledged.
		const theirs = '---\ntitle: Theirs\naudioPath: audio/other.webm\n---\n';
		expectOk(await folder.files.overwrite('recordings/take.md', theirs));
		expectOk(await folder.files.overwrite('audio/take.webm', 'not audio'));

		// The receipt still names the bytes this batch saved.
		const [audioStep, rowStep] = receipt.steps;
		if (audioStep?.kind !== 'write' || rowStep?.kind !== 'write')
			throw new Error('expected two writes');
		expect(audioStep.file.version).toEqual(await captureVersion(AUDIO));
		expect(rowStep.file.version).toEqual(
			await captureVersion(encoder.encode(rowSource('take'))),
		);
		// An explicit get observes the other writer's row, not this batch's.
		const observed = expectOk(await folder.tables.recordings.get('take'));
		expect(observed?.fields).toEqual({
			title: 'Theirs',
			audioPath: 'audio/other.webm',
		});
		expect(observed?.version).not.toEqual(rowStep.file.version);
		// So the receipt cannot be used to overwrite what it never saw.
		expect(
			expectErr(await folder.files.replace(rowStep.file, rowSource('take')))
				.name,
		).toBe('Conflict');
		expect(expectErr(await folder.files.remove(audioStep.file)).name).toBe(
			'Conflict',
		);
	});

	test('a closed folder refuses the batch without calling the callback', async () => {
		const folder = await open();
		await folder.close();
		let calls = 0;
		const refused = expectErr(
			await folder.batch(() => {
				calls++;
			}),
		);
		expect(refused.name).toBe('Closed');
		expect(calls).toBe(0);
	});
});

describe.each([
	'browser',
	'directory',
])('%s folder batch row destinations', (kind) => {
	/** A folder holding `recordings/Review.md`, and what a refusal must leave alone. */
	async function withReview() {
		const folder =
			kind === 'browser'
				? await openBrowser(true)
				: (await openDirectory(true)).folder;
		const review = expectOk(
			await folder.tables.recordings.create(recording('Review')),
		);
		await settled(folder);
		const commits = expectOk(await folder.git.log(10)).length;
		const before = (await paths(folder)).sort();
		const heard: string[] = [];
		folder.onFilesChanged((changed) => heard.push(...changed));
		return {
			folder,
			review,
			/** Nothing was published: no file, no hint, no commit. */
			async untouched() {
				await settled(folder);
				expect((await paths(folder)).sort()).toEqual(before);
				expect(heard).toEqual([]);
				expect(expectOk(await folder.git.log(10))).toHaveLength(commits);
			},
		};
	}

	test('a batched row is refused exactly as a standalone create is: occupied, and case-colliding', async () => {
		const { folder, untouched } = await withReview();
		let calls = 0;

		for (const stem of ['review', 'Review', 'REVIEW']) {
			const standalone = expectErr(
				await folder.tables.recordings.create(recording(stem)),
			);
			const batched = expectErr(
				await folder.batch((batch) => {
					calls++;
					// Collected first, so a refusal after publication would show.
					batch.files.create(`audio/${stem}.webm`, AUDIO);
					batch.tables.recordings.create(recording(stem));
				}),
			);
			// The same error, field for field, from the same check.
			expect(batched).toEqual(standalone);
			expect(batched.name).toBe(stem === 'Review' ? 'Exists' : 'Collision');
		}
		expect(calls).toBe(3);
		await untouched();
	});

	test('two collected rows that collide with each other are refused before either is published', async () => {
		const { folder, untouched } = await withReview();
		const refused = expectErr(
			await folder.batch((batch) => {
				batch.tables.recordings.create(recording('Draft'));
				batch.tables.recordings.create(recording('draft'));
			}),
		);
		expect(refused).toMatchObject({
			name: 'Collision',
			path: 'recordings/draft.md',
			existing: 'recordings/Draft.md',
		});
		const twice = expectErr(
			await folder.batch((batch) => {
				batch.tables.recordings.create(recording('Draft'));
				batch.tables.recordings.create(recording('Draft'));
			}),
		);
		expect(twice).toMatchObject({
			name: 'Exists',
			path: 'recordings/Draft.md',
		});
		// An ordinary file the same batch creates under a colliding name counts.
		const afterFile = expectErr(
			await folder.batch((batch) => {
				batch.files.create('recordings/NOTES.md', 'plain');
				batch.tables.recordings.create(recording('notes'));
			}),
		);
		expect(afterFile).toMatchObject({
			name: 'Collision',
			existing: 'recordings/NOTES.md',
		});
		await untouched();
	});

	test('the plan is read in order: a row retired earlier in the batch frees its name', async () => {
		const { folder, review } = await withReview();
		// Removing the captured row first makes room for its case variant.
		const replaced = expectOk(
			await folder.batch((batch) => {
				batch.files.remove(review);
				batch.tables.recordings.create(recording('review'));
			}),
		);
		expect(replaced.steps.map((step) => step.kind)).toEqual([
			'remove',
			'write',
		]);
		expect((await paths(folder)).sort()).toEqual(['recordings/review.md']);

		// Moving a captured row away frees its name too, and the move's
		// destination becomes a name a later row can collide with.
		const current = expectOk(await folder.tables.recordings.get('review'));
		if (current === undefined) throw new Error('the row is missing');
		const moved = expectOk(
			await folder.batch((batch) => {
				batch.files.move(current, 'recordings/Archived.md');
				batch.tables.recordings.create(recording('REVIEW'));
			}),
		);
		expect(moved.steps.map((step) => step.kind)).toEqual(['move', 'write']);
		const collides = expectErr(
			await folder.batch((batch) => {
				batch.files.move(
					{ path: 'recordings/Archived.md', version: current.version },
					'recordings/Kept.md',
				);
				batch.tables.recordings.create(recording('kept'));
			}),
		);
		expect(collides).toMatchObject({
			name: 'Collision',
			existing: 'recordings/Kept.md',
		});
		// The reverse order is refused: the create comes before the removal.
		const tooEarly = expectErr(
			await folder.batch((batch) => {
				batch.tables.recordings.create(recording('archived'));
				batch.files.remove({
					path: 'recordings/Archived.md',
					version: current.version,
				});
			}),
		);
		expect(tooEarly.name).toBe('Collision');
		expect((await paths(folder)).sort()).toEqual([
			'recordings/Archived.md',
			'recordings/REVIEW.md',
		]);
	});

	test('a same-stem sibling that is not a row file never blocks a batched row', async () => {
		const { folder } = await withReview();
		expectOk(await folder.files.create('recordings/take.webm', AUDIO));
		expectOk(await folder.files.create('recordings/TAKE.wav', AUDIO));
		const receipt = expectOk(
			await folder.batch((batch) => {
				batch.tables.recordings.create(recording('take'));
			}),
		);
		expect(receipt.steps).toHaveLength(1);
		expect((await paths(folder)).sort()).toEqual([
			'recordings/Review.md',
			'recordings/TAKE.wav',
			'recordings/take.md',
			'recordings/take.webm',
		]);
	});
});

test('a browser batch lands whole or not at all', async () => {
	const folder = await openBrowser(true);
	expectOk(await folder.tables.recordings.create(recording('take')));
	await settled(folder);
	const commits = expectOk(await folder.git.log(10)).length;
	const heard: string[] = [];
	folder.onFilesChanged((changed) => heard.push(...changed));

	// The last step's condition fails at publication: the row file is no
	// longer the captured one. The audio and the new row collected before it
	// are not in the folder either.
	const stale = {
		path: 'recordings/take.md',
		version: { sha256: '0'.repeat(64), size: 1 },
	};
	const refused = expectErr(
		await folder.batch((batch) => {
			batch.files.create('audio/next.webm', AUDIO);
			batch.tables.recordings.create(recording('next'));
			batch.files.replace(stale, 'built on a stale read');
		}),
	);
	expect(refused).toMatchObject({
		name: 'Conflict',
		path: 'recordings/take.md',
		expected: stale.version,
	});
	await settled(folder);
	expect(await paths(folder)).toEqual(['recordings/take.md']);
	expect(expectOk(await folder.git.log(10))).toHaveLength(commits);
	expect(heard).toEqual([]);
});

describe('a directory batch that stops partway', () => {
	test('reports the steps that landed, requests no commit, and is recovered by one more batch', async () => {
		const { folder, root } = await openDirectory(true);
		// A directory already has the row's name, so the row cannot be written.
		await mkdir(join(root, 'recordings', 'take.md'), { recursive: true });
		const heard: string[] = [];
		folder.onFilesChanged((changed) => heard.push(...changed));
		const pending = new Uint8Array(AUDIO);

		const partial = expectErr(
			await folder.batch((batch) => {
				batch.files.create('audio/take.webm', pending);
				batch.tables.recordings.create(recording('take'));
				batch.files.create('never.txt', 'not attempted');
			}),
		);
		expect(partial).toMatchObject({
			name: 'Partial',
			applied: [{ kind: 'write', path: 'audio/take.webm' }],
			failed: { kind: 'write', path: 'recordings/take.md' },
			notAttempted: [{ kind: 'write', path: 'never.txt' }],
		});
		// The audio is on disk; nothing was rolled back and nothing replayed.
		expect(
			new Uint8Array(await readFile(join(root, 'audio/take.webm'))),
		).toEqual(AUDIO);
		expect(await readdir(root)).not.toContain('never.txt');
		expect(heard).toEqual(['audio/take.webm']);
		await settled(folder);
		expect(folder.git.snapshot.lastCommit).toBeUndefined();

		// Recovery. The caller still holds the pending bytes and the ID. It
		// looks at what is there, and only after verifying the audio is its own
		// does it publish again: the replace is conditional on exactly the bytes
		// it observed, and the row is created with them in the same batch.
		await rmdir(join(root, 'recordings', 'take.md'));
		const observed = expectOk(await folder.files.read('audio/take.webm'));
		expect(observed.version).toEqual(await captureVersion(pending));
		const recovered = expectOk(
			await folder.batch((batch) => {
				batch.files.replace(observed, pending);
				batch.tables.recordings.create(recording('take'));
			}),
		);
		expect(recovered.steps.map((step) => step.kind)).toEqual([
			'write',
			'write',
		]);
		await settled(folder);
		expect(await git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe(
			'audio/take.webm\nrecordings/take.md',
		);
		expect(await git(root, 'status', '--porcelain')).toBe('');
	});

	test('recovery refuses audio another writer replaced, and the row is not created over it', async () => {
		const { folder, root } = await openDirectory();
		expectOk(await folder.files.create('audio/take.webm', AUDIO));
		const observed = expectOk(await folder.files.read('audio/take.webm'));
		// Another program rewrites the audio after it was observed.
		await writeFile(join(root, 'audio/take.webm'), 'someone else');

		const refused = expectErr(
			await folder.batch((batch) => {
				batch.files.replace(observed, AUDIO);
				batch.tables.recordings.create(recording('take'));
			}),
		);
		expect(refused).toMatchObject({
			name: 'Conflict',
			path: 'audio/take.webm',
			expected: observed.version,
		});
		expect(await readFile(join(root, 'audio/take.webm'), 'utf8')).toBe(
			'someone else',
		);
		expect((await paths(folder)).sort()).toEqual(['audio/take.webm']);
	});
});
