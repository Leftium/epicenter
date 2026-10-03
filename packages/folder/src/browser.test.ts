/**
 * Browser folders over fake IndexedDB with real isomorphic-git objects.
 *
 * Complete table, KV, and file publications request automatic history without
 * waiting for it. Conflicts and directory operations request no history;
 * staged authoring requires manual mode, including through the folder shell.
 * A table reads and writes one Markdown file per row and leaves every other
 * file alone.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { DataSchema } from '@epicenter/definition';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import * as isogit from 'isomorphic-git';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	defineFolder,
	defineTable,
	type Folder,
	field,
	openFolder,
} from './browser.js';
import {
	createBrowserFileBoundary,
	type IndexedDbEnvironment,
	openFolderDatabase,
} from './browser-store.js';
import { hashBytes } from './capture.js';
import { createBrowserGitBackend } from './git/browser-backend.js';
import { createGitSession, GITDIR } from './git/browser-fs.js';
import { createHistory } from './git/history.js';
import { useWebLocks } from './web-locks.test-support.js';

const definition = defineFolder({
	kv: { theme: field.string() },
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});

const author = { name: 'Browser', email: 'browser@example.test' };

let environment: IndexedDbEnvironment;
const opened: Folder<typeof definition>[] = [];

async function open(options: { commitOnEdit?: boolean; id?: string } = {}) {
	environment ??= { indexedDB: new IDBFactory(), IDBKeyRange };
	const folder = expectOk(
		await openFolder({
			id: options.id ?? 'test',
			definition,
			browser: {
				author,
				commitOnEdit: options.commitOnEdit,
				indexedDb: environment,
			},
		}),
	);
	opened.push(folder);
	return folder;
}

afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
	environment = { indexedDB: new IDBFactory(), IDBKeyRange };
});

/** Wait for background commit work to settle. */
/** Wait for the commit attempt a save started, and its push, to settle. */
async function settled(folder: Folder<typeof definition>) {
	for (let index = 0; index < 400; index++) {
		const { activity } = folder.git.snapshot;
		if (!activity.commit.active && !activity.push.active) return;
		await Bun.sleep(5);
	}
	throw new Error('Git work did not settle');
}

describe('browser folder tables', () => {
	test('a repository previously opened on another branch refuses a new main history', async () => {
		environment = { indexedDB: new IDBFactory(), IDBKeyRange };
		const db = await openFolderDatabase(
			'epicenter-folder:legacy-branch',
			environment,
		);
		const backend = await createBrowserGitBackend({
			db,
			environment,
			lockName: 'legacy-branch',
			branch: 'backup',
			remote: undefined,
		});
		const boundary = createBrowserFileBoundary(db, environment);
		const history = createHistory({
			backend,
			boundary,
			author,
			commitOnEdit: false,
		});
		const bytes = new TextEncoder().encode('previous history');
		expectOk(
			await boundary.apply([
				{
					kind: 'create',
					path: 'legacy.txt',
					bytes,
					sha256: await hashBytes(bytes),
				},
			]),
		);
		expect((await history.commit()).status).toBe('committed');
		const previous = await backend.readBranch();
		await history.close();
		const folder = await open({ id: 'legacy-branch', commitOnEdit: false });
		expectOk(await folder.files.create('saved.txt', 'saved'));
		expect(await folder.git.commit()).toMatchObject({
			status: 'blocked',
			reason: 'HEAD is not on main',
		});
		expect(expectOk(await folder.files.read('saved.txt')).bytes).toEqual(
			new TextEncoder().encode('saved'),
		);
		expect(expectOk(await folder.git.log(10))).toEqual([]);
		expect(await backend.readBranch()).toBe(previous);
		const session = createGitSession(db, environment);
		await expect(
			isogit.resolveRef({
				fs: session.fs,
				gitdir: GITDIR,
				ref: 'refs/heads/main',
			}),
		).rejects.toThrow();
		db.close();
	});

	test('creates, lists, updates, completes, renames, and deletes plain Markdown rows', async () => {
		const folder = await open({ commitOnEdit: false });
		const created = await folder.tables.todos.create({
			stem: 'milk',
			fields: { title: 'Buy milk', done: false },
			body: 'Two liters.\n',
		});
		expect(created.error).toBeNull();
		expect(created.data!.path).toBe('todos/milk.md');
		expect(created.data!.source).toBe(
			'---\ntitle: Buy milk\ndone: false\n---\nTwo liters.\n',
		);
		const raw = await folder.files.read('todos/milk.md');
		expect(new TextDecoder().decode(raw.data!.bytes)).toBe(
			created.data!.source,
		);
		expect(raw.data!.sha256).toEqual(created.data!.sha256);

		const completed = await folder.tables.todos.update('milk', {
			fields: { done: true },
		});
		expect(expectOk(completed)).toMatchObject({
			fields: { title: 'Buy milk', done: true },
			body: 'Two liters.\n',
			parseError: undefined,
			issues: [],
		});

		const renamed = await folder.tables.todos.rename(
			completed.data!,
			'groceries',
		);
		expect(renamed.data!.path).toBe('todos/groceries.md');
		expect((await folder.tables.todos.get('milk')).data).toBeUndefined();
		const listed = expectOk(await folder.tables.todos.list());
		expect(listed.map((item) => expectOk(item.result).stem)).toEqual([
			'groceries',
		]);

		expectOk(await folder.tables.todos.delete(renamed.data!));
		expect(expectOk(await folder.tables.todos.list())).toEqual([]);
	});

	test('create is exclusive, keeps names exactly, and refuses a path outside its table', async () => {
		const folder = await open({ commitOnEdit: false });
		await folder.tables.todos.create({
			stem: 'Plan',
			fields: { title: 'P', done: false },
		});
		expect(
			(
				await folder.tables.todos.create({
					stem: 'Plan',
					fields: { title: 'Q', done: false },
				})
			).error?.name,
		).toBe('Exists');
		// Browser storage keeps names exactly: another spelling is another row.
		expect(
			expectOk(
				await folder.tables.todos.create({
					stem: 'plan',
					fields: { title: 'Q', done: false },
				}),
			).path,
		).toBe('todos/plan.md');
		expect(
			(
				await folder.tables.todos.create({
					stem: '../x',
					fields: { title: 'Q', done: false },
				})
			).error?.name,
		).toBe('InvalidPath');
		expect(
			(
				await folder.tables.todos.create({
					stem: 'ok',
					fields: { title: 3 as unknown as string, done: false },
				})
			).error?.name,
		).toBe('InvalidValues');
	});

	test('readable rows stay snapshots: field issues beside valid fields, and a parse failure with no fields', async () => {
		const folder = await open({ commitOnEdit: false });
		const source =
			'﻿---\r\ntitle: Kept # comment\r\ndone: maybe\r\nextra: unknown\r\n---\r\nBody\r\n';
		await folder.files.create('todos/odd.md', source);
		await folder.files.create('todos/broken.md', '---\ntitle: [\n---\n');
		await folder.files.create(
			'todos/bad.md',
			new Uint8Array([0xff, 0xfe, 0x00]),
		);
		const listed = expectOk(await folder.tables.todos.list());
		const item = (path: string) =>
			listed.find((found) => found.path === path)!.result;
		expect(expectErr(item('todos/bad.md')).name).toBe('InvalidUtf8');
		const odd = expectOk(item('todos/odd.md'));
		expect(odd.source).toBe(source);
		expect(odd.parseError).toBeUndefined();
		expect(odd.issues.map((issue) => issue.field)).toEqual(['done']);
		expect(odd.fields).toEqual({ title: 'Kept' });
		expect(odd.stem).toBe('odd');

		// A typed update of the valid-in-isolation field replaces only that span.
		const fixed = await folder.tables.todos.update('odd', {
			fields: { done: true },
		});
		expect(fixed.data!.source).toBe(
			source.replace('done: maybe', 'done: true'),
		);
		expect(fixed.data!.issues).toEqual([]);

		const broken = expectOk(item('todos/broken.md'));
		expect(broken.parseError).toBeDefined();
		expect(broken).toMatchObject({ fields: {}, body: undefined, issues: [] });
		expect(
			(await folder.tables.todos.update('broken', { fields: { done: true } }))
				.error?.name,
		).toBe('Unparsed');
		const repaired = expectOk(
			await folder.tables.todos.replace(
				broken,
				'---\ntitle: Repaired\ndone: false\n---\n',
			),
		);
		expect(repaired).toMatchObject({
			fields: { title: 'Repaired', done: false },
			parseError: undefined,
			issues: [],
		});
	});

	test('same-stem siblings are ordinary files: a row is created beside them, and rename and delete leave them', async () => {
		const folder = await open({ commitOnEdit: false });
		const audio = new Uint8Array([1, 2, 3]);
		// The audio exists first. It does not block the row that shares its stem.
		const opus = expectOk(await folder.files.create('todos/rec.opus', audio));
		expectOk(await folder.files.create('todos/rec.wav', new Uint8Array([9])));
		const created = expectOk(
			await folder.tables.todos.create({
				stem: 'rec',
				fields: { title: 'Recording', done: false },
			}),
		);
		// Siblings can also arrive after the row was captured.
		expectOk(await folder.files.create('todos/rec.flac', 'late'));
		expect(created.issues).toEqual([]);
		// A snapshot is the capture and its reading: no attachment, no sibling.
		expect(Object.keys(created).sort()).toEqual([
			'body',
			'fields',
			'issues',
			'parseError',
			'path',
			'sha256',
			'source',
			'stem',
		]);
		// Two siblings are not an ambiguity; the listed row is as valid as it was.
		const listed = expectOk(await folder.tables.todos.list());
		expect(listed.map((item) => expectOk(item.result))).toEqual([created]);

		const renamed = expectOk(await folder.tables.todos.rename(created, 'rec2'));
		expect(renamed.path).toBe('todos/rec2.md');
		expect(expectOk(await folder.files.children('todos')).files).toEqual([
			'rec.flac',
			'rec.opus',
			'rec.wav',
			'rec2.md',
		]);

		const kept = expectOk(await folder.files.read('todos/rec.opus'));
		expect(kept.bytes).toEqual(audio);
		expect(kept.sha256).toEqual(opus.sha256);
		// Changing and moving a sibling cannot change what row deletion owns.
		const movedAudio = expectOk(
			await folder.files.move(opus, 'todos/rec2.opus'),
		);
		const changedAudio = expectOk(
			await folder.files.replace(movedAudio, 'rewritten'),
		);
		expectOk(await folder.tables.todos.delete(renamed));
		expect(expectOk(await folder.files.children('todos')).files).toEqual([
			'rec.flac',
			'rec.wav',
			'rec2.opus',
		]);
		const surviving = expectOk(await folder.files.read('todos/rec2.opus'));
		expect(new TextDecoder().decode(surviving.bytes)).toBe('rewritten');
		expect(surviving.sha256).toEqual(changedAudio.sha256);

		// `rec.take.md` is its own row, not something `rec.md` owns.
		expectOk(
			await folder.files.create(
				'todos/rec.take.md',
				'---\ntitle: T\ndone: false\n---\n',
			),
		);
		expect(expectOk(await folder.tables.todos.get('rec.take'))).toMatchObject({
			parseError: undefined,
			issues: [],
		});
	});

	test('rejects a definition that supplies a body codec', async () => {
		const withCodec: DataSchema = {
			kv: {},
			tables: {
				notes: defineTable({
					fields: { title: field.string() },
					body: { encode: () => '', decode: () => undefined },
				}),
			},
		};
		const indexedDB = new IDBFactory();
		const refused = expectErr(
			await openFolder({
				id: 'codec',
				definition: withCodec,
				browser: { author, indexedDb: { indexedDB, IDBKeyRange } },
			}),
		);
		expect(refused.name).toBe('InvalidDefinition');
		expect(refused.message).toContain('body codec');
		// Refused before any storage was acquired.
		expect(await indexedDB.databases()).toEqual([]);
		// The same definition is refused where it would be declared.
		expect(() => defineFolder(withCodec as never)).toThrow('body codec');
	});

	test('admits a reference field as a string that nothing checks or repairs', async () => {
		const withReference = defineFolder({
			kv: {},
			tables: {
				lists: defineTable({ fields: { title: field.string() } }),
				todos: defineTable({
					fields: { title: field.string(), list: field.reference('lists') },
				}),
			},
		});
		const folder = expectOk(
			await openFolder({
				id: 'references',
				definition: withReference,
				browser: {
					author,
					commitOnEdit: false,
					indexedDb: { indexedDB: new IDBFactory(), IDBKeyRange },
				},
			}),
		);
		try {
			const { lists, todos } = folder.tables;
			// The schema is the whole check: a nonempty string, existing or not.
			expect(
				expectErr(
					await todos.create({
						stem: 'empty',
						fields: { title: 'T', list: '' },
					}),
				).name,
			).toBe('InvalidValues');
			expectOk(
				await todos.create({
					stem: 'dangling',
					fields: { title: 'T', list: 'no-such-list' },
				}),
			);
			const home = expectOk(
				await lists.create({ stem: 'home', fields: { title: 'Home' } }),
			);
			expectOk(
				await todos.create({
					stem: 'milk',
					fields: { title: 'M', list: 'home' },
				}),
			);

			// Renaming the row a reference names rewrites nothing that names it.
			expectOk(await lists.rename(home, 'house'));
			for (const [stem, list] of [
				['milk', 'home'],
				['dangling', 'no-such-list'],
			] as const) {
				const row = expectOk(await todos.get(stem));
				expect(row).toMatchObject({ fields: { list }, issues: [] });
			}
		} finally {
			await folder.close();
		}
	});

	test('a todo with an unresolvable alias stays a snapshot and is repaired through its source', async () => {
		const folder = await open({ commitOnEdit: false });
		const source = '---\ntitle: *missing\ndone: false\n---\nNotes stay.\n';
		await folder.files.create('todos/alias.md', source);
		const listed = expectOk(await folder.tables.todos.list());
		expect(listed).toHaveLength(1);
		const entry = expectOk(listed[0]!.result);
		expect(entry.source).toBe(source);
		// The source is the repair baseline; a failed parse recovers no body.
		expect(entry.parseError?.diagnostics[0].message).toContain(
			'Unresolved alias',
		);
		expect(entry.body).toBeUndefined();

		// A structured edit, as the editor's title field makes, is refused safely.
		for (const change of [{ fields: { title: 'Fixed' } }, { body: 'New.\n' }])
			expect(
				expectErr(await folder.tables.todos.update(entry.stem, change)).name,
			).toBe('Unparsed');
		expect((await folder.tables.todos.get('alias')).data!.source).toBe(source);

		const repaired = expectOk(
			await folder.tables.todos.replace(
				entry,
				source.replace('*missing', 'Fixed'),
			),
		);
		expect(repaired).toMatchObject({
			fields: { title: 'Fixed', done: false },
			body: 'Notes stay.\n',
			parseError: undefined,
			issues: [],
		});
	});

	test('kv.json is created exclusively and updated inside its own source', async () => {
		const folder = await open({ commitOnEdit: false });
		expect(expectOk(await folder.kv.get())).toBeUndefined();
		expect(expectErr(await folder.kv.update({ theme: 'dark' })).name).toBe(
			'NotFound',
		);
		await folder.files.create('kv.json', '{\n  "other": 1\n}\n');
		expect(expectErr(await folder.kv.create({ theme: 'dark' })).name).toBe(
			'Exists',
		);
		const updated = expectOk(await folder.kv.update({ theme: 'dark' }));
		expect(updated.source).toBe('{\n  "other": 1,\n  "theme": "dark"\n}\n');
		expect(expectOk(await folder.kv.get())).toEqual(updated);
	});
});

describe('browser folder persistence and history', () => {
	test('files, directories, and history survive reopening the database', async () => {
		const first = await open();
		await first.tables.todos.create({
			stem: 'kept',
			fields: { title: 'Kept', done: false },
		});
		await first.files.mkdir('empty/dir');
		await settled(first);
		const head = first.git.snapshot.lastCommit;
		expect(head?.status).toBe('committed');
		await first.close();

		const second = await open();
		expect(expectOk(await second.tables.todos.get('kept'))?.fields.title).toBe(
			'Kept',
		);
		expect((await second.files.children('empty')).data!.directories).toEqual([
			'dir',
		]);
		const log = await second.git.log(10);
		expect(log.data!.map((commit) => commit.message)).toEqual([
			'Add todos/kept.md\n',
		]);
		const status = await second.git.status();
		expect(status.data!.changes).toEqual([]);
	});

	test('file create, move, and remove request automatic history', async () => {
		const folder = await open();
		const created = expectOk(
			await folder.files.create('notes/raw.txt', 'hello'),
		);
		// The save returned; its commit attempt is still running.
		expect(folder.git.snapshot.activity.commit.active).toBe(true);
		await settled(folder);
		expect(folder.git.snapshot.lastCommit).toMatchObject({
			status: 'committed',
			message: 'Add notes/raw.txt',
		});
		const moved = expectOk(await folder.files.move(created, 'moved.txt'));
		await settled(folder);
		expect((await folder.git.status()).data!.changes).toEqual([]);
		expectOk(await folder.files.remove(moved));
		await settled(folder);
		expect(folder.git.snapshot.lastCommit).toMatchObject({
			status: 'committed',
			message: 'Delete moved.txt',
		});
		expect((await folder.git.log(10)).data).toHaveLength(3);
	});

	test('directories and refused content saves request no history', async () => {
		const folder = await open();
		expectOk(await folder.files.mkdir('empty'));
		expectOk(await folder.files.rmdir('empty'));
		const conflict = expectErr(
			await folder.files.replace(
				{ path: 'missing.txt', sha256: '0'.repeat(64) },
				'x',
			),
		);
		expect(conflict.name).toBe('Conflict');
		expect(folder.git.snapshot.lastCommit).toBeUndefined();
		expect(folder.git.snapshot.activity.commit).toEqual({ active: false });
	});

	test('automatic mode refuses staging and a staged commit', async () => {
		const folder = await open();
		expect(expectErr(await folder.git.stage('all')).name).toBe(
			'AutomaticHistory',
		);
		expect(expectErr(await folder.git.commitStaged('Authored')).name).toBe(
			'AutomaticHistory',
		);
		expect((await folder.git.paths()).data).toEqual([]);
	});

	test('KV publication requests automatic history under the same policy', async () => {
		const folder = await open();
		expectOk(await folder.kv.create({ theme: 'dark' }));
		await settled(folder);
		expect(folder.git.snapshot.lastCommit).toMatchObject({
			status: 'committed',
			message: 'Add kv.json',
		});
		expectOk(await folder.kv.update({ theme: 'light' }));
		await settled(folder);
		expect(folder.git.snapshot.lastCommit).toMatchObject({
			status: 'committed',
			message: 'Update kv.json',
		});
	});

	test('subscribe delivers the cached snapshot synchronously, unknown before the first scan', async () => {
		const folder = await open({ commitOnEdit: false });
		const seen: string[] = [];
		const unsubscribe = folder.git.subscribe((snapshot) =>
			seen.push(snapshot.files.state),
		);
		expect(seen).toEqual(['unknown']);
		expect(folder.git.snapshot.commitOnEdit).toBe(false);
		await folder.git.status();
		expect(seen.at(-1)).toBe('observed');
		await folder.files.create('x.txt', 'x');
		const files = folder.git.snapshot.files;
		expect(files.state === 'observed' && files.stale).toBe(true);
		unsubscribe();
	});

	test('commitOnEdit false suppresses implicit commits; commitAndPush still commits', async () => {
		const folder = await open({ commitOnEdit: false });
		await folder.tables.todos.create({
			stem: 'manual',
			fields: { title: 'M', done: false },
		});
		expectOk(await folder.files.create('manual.txt', 'x'));
		expectOk(await folder.kv.create({}));
		await Bun.sleep(20);
		expect(folder.git.snapshot.lastCommit).toBeUndefined();
		const result = await folder.git.commitAndPush();
		expect(result.commit.status).toBe('committed');
		expect(result.push.status).toBe('noRemote');
	});

	test('a stalled push blocks neither saves nor commits; a commit made meanwhile stays local; close aborts the push and settles', async () => {
		const originalFetch = globalThis.fetch;
		let requests = 0;
		globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
			requests++;
			return new Promise<Response>((_resolve, reject) =>
				init?.signal?.addEventListener('abort', () =>
					reject(new DOMException('The push was cancelled', 'AbortError')),
				),
			);
		}) as typeof fetch;
		try {
			environment = { indexedDB: new IDBFactory(), IDBKeyRange };
			const folder = expectOk(
				await openFolder({
					id: 'stall',
					definition,
					browser: {
						author,
						remote: { url: 'http://stall.test/remote.git', branch: 'main' },
						indexedDb: environment,
					},
				}),
			);
			await folder.tables.todos.create({
				stem: 'a',
				fields: { title: 'A', done: false },
			});
			await settled(folder);
			expect(requests).toBe(0);
			const pushing = folder.git.push();
			for (let index = 0; index < 200 && requests === 0; index++)
				await Bun.sleep(5);
			expect(folder.git.snapshot.activity.push.active).toBe(true);

			const saved = await folder.tables.todos.create({
				stem: 'b',
				fields: { title: 'B', done: false },
			});
			expect(saved.error).toBeNull();
			for (let index = 0; index < 200; index++) {
				if (!folder.git.snapshot.activity.commit.active) break;
				await Bun.sleep(5);
			}
			const lastCommit = folder.git.snapshot.lastCommit;
			expect(lastCommit?.status === 'committed' && lastCommit.message).toBe(
				'Add todos/b.md',
			);
			// That commit is local: its push was not started behind the stalled one.
			expect(folder.git.snapshot.activity.push.active).toBe(true);

			await folder.close();
			expect((await pushing).status).toBe('cancelled');
			expect(folder.git.snapshot.lastPush?.status).toBe('cancelled');
			expect(folder.git.snapshot.activity.push).toEqual({ active: false });
			expect(requests).toBe(1);
			expect((await folder.tables.todos.list()).error?.name).toBe('Closed');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('a competing branch update refuses the checkpoint without a forced update', async () => {
		environment = { indexedDB: new IDBFactory(), IDBKeyRange };
		const db = await openFolderDatabase('epicenter-folder:cas', environment);
		const boundary = createBrowserFileBoundary(db, environment);
		const backend = await createBrowserGitBackend({
			db,
			environment,
			lockName: 'cas',
			branch: 'main',
			remote: undefined,
		});
		let competitor: string | undefined;
		const history = createHistory({
			backend: {
				...backend,
				async casBranch(expected, next) {
					// Another writer moves the branch between capture and publication.
					competitor = await backend.withObjects((access) =>
						isogit.writeCommit({
							...access,
							commit: {
								tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
								parent: [],
								author: { ...author, timestamp: 1, timezoneOffset: 0 },
								committer: { ...author, timestamp: 1, timezoneOffset: 0 },
								message: 'Competitor\n',
							},
						}),
					);
					await isogit.writeTree({ ...(await sessionAccess()), tree: [] });
					expect((await backend.casBranch(expected, competitor)).ok).toBe(true);
					return backend.casBranch(expected, next);
				},
			},
			boundary,
			author,
			commitOnEdit: false,
		});
		async function sessionAccess() {
			const session = createGitSession(db, environment);
			return { fs: session.fs, gitdir: GITDIR };
		}
		await boundary.apply([
			{
				kind: 'create',
				path: 'a.txt',
				bytes: new TextEncoder().encode('a'),
				sha256:
					'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
			},
		]);
		const outcome = await history.commit();
		expect(outcome.status).toBe('branchMoved');
		if (outcome.status === 'branchMoved') {
			expect(outcome.actual).toBe(competitor);
			expect(outcome.candidate).not.toBe(competitor);
		}
		expect(await backend.readBranch()).toBe(competitor);
		await history.close();
		db.close();
	});
});

describe('browser terminal', () => {
	test('shell writes use automatic history and reject staged authoring', async () => {
		const folder = await open();
		const terminal = folder.terminal();
		expect((await terminal.exec('echo text > typed.txt')).exitCode).toBe(0);
		await settled(folder);
		expect(folder.git.snapshot.lastCommit?.status).toBe('committed');
		expect(
			new TextDecoder().decode(
				expectOk(await folder.files.read('typed.txt')).bytes,
			),
		).toBe('text\n');
		// A redirect publishes the empty file and then its content, one attempt
		// each. When the second finds the first still running, the content is
		// saved and uncommitted until the next request.
		await folder.git.commit();
		expect(expectOk(await folder.git.status()).changes).toEqual([]);
		const before = expectOk(await folder.git.log(10)).map(
			(commit) => commit.oid,
		);
		for (const command of ['git add typed.txt', 'git commit -m "Authored"']) {
			const refused = await terminal.exec(command);
			expect(refused.exitCode).not.toBe(0);
			expect(refused.stderr).toContain('commitOnEdit: false');
		}
		expect(
			expectOk(await folder.git.log(10)).map((commit) => commit.oid),
		).toEqual(before);
	});

	test('shell reads and writes the same files; git staging semantics are real', async () => {
		const folder = await open({ commitOnEdit: false });
		const terminal = folder.terminal();
		await folder.tables.todos.create({
			stem: 'one',
			fields: { title: 'One', done: false },
		});

		expect((await terminal.exec('ls todos')).stdout).toBe('one.md\n');
		expect((await terminal.exec('cat todos/one.md')).stdout).toContain(
			'title: One',
		);
		const wrote = await terminal.exec(
			'echo "shell note" > notes.txt && mkdir -p a/b && ls',
		);
		expect(wrote.exitCode).toBe(0);
		expect(wrote.stdout.split('\n')).toContain('notes.txt');
		expect(
			new TextDecoder().decode(
				(await folder.files.read('notes.txt')).data!.bytes,
			),
		).toBe('shell note\n');
		// This folder opted out of automatic commits for staged authoring.
		expect(folder.git.snapshot.lastCommit).toBeUndefined();

		let status = await terminal.exec('git status');
		expect(status.stdout).toBe('## main\n?? notes.txt\n?? todos/one.md\n');
		expect((await terminal.exec('git add notes.txt')).exitCode).toBe(0);
		status = await terminal.exec('git status');
		expect(status.stdout).toBe('## main\nA  notes.txt\n?? todos/one.md\n');
		const committed = await terminal.exec('git commit -m "Add a shell note"');
		expect(committed.exitCode).toBe(0);
		expect(committed.stdout).toMatch(
			/^\[main [0-9a-f]{7}\] Add a shell note\n$/,
		);
		expect(folder.git.snapshot.lastCommit).toMatchObject({
			status: 'committed',
			message: 'Add a shell note',
			changedPaths: 1,
		});
		status = await terminal.exec('git status');
		expect(status.stderr).toBe('');
		expect(status.stdout).toBe('## main\n?? todos/one.md\n');

		await terminal.exec('echo "more" >> notes.txt');
		status = await terminal.exec('git status --short');
		expect(status.stdout).toBe('## main\n M notes.txt\n?? todos/one.md\n');
		const diff = await terminal.exec('git diff');
		expect(diff.stdout).toContain('+more');
		expect(diff.stdout).toContain('diff --git a/notes.txt b/notes.txt');
		await terminal.exec('git add -A');
		expect((await terminal.exec('git diff --cached')).stdout).toContain(
			'+more',
		);
		expect((await terminal.exec('git commit -m "   "')).exitCode).not.toBe(0);
		expect((await terminal.exec('git commit -m "Second"')).exitCode).toBe(0);
		expect((await terminal.exec('git log --oneline')).stdout).toMatch(
			/^[0-9a-f]{7} Second\n[0-9a-f]{7} Add a shell note\n$/,
		);
		expect((await terminal.exec('git commit -m "Nothing"')).stderr).toBe(
			'nothing added to commit\n',
		);
		expect((await terminal.exec('git rebase main')).exitCode).toBe(1);

		// Automatic checkpoints keep the index consistent with the new head.
		await terminal.exec('echo "auto" > auto.txt');
		expect((await folder.git.commit()).status).toBe('committed');
		expect((await terminal.exec('git status')).stdout).toBe(
			'## main\nnothing to commit, working tree clean\n',
		);
		expect((await terminal.exec('rm auto.txt && git status')).stdout).toBe(
			'## main\n D auto.txt\n',
		);
		expect((await terminal.exec('cd todos && pwd')).stdout).toBe('/todos\n');
		expect(terminal.cwd).toBe('/todos');
	});
});

// Automatic commits need the shared lock; this runtime has none of its own.
useWebLocks();
