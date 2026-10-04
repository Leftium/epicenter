/**
 * Directory folders against real Git, and browser/directory exchange through
 * a real bare repository served by `git http-backend`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DataSchema } from '@epicenter/definition';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder as openBrowserFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
	rawBrowserFolder,
	testBrowserStorage,
} from './browser-storage.test-support.js';
import {
	type DirectoryFolderOptions,
	defineFolder,
	defineTable,
	type Folder,
	type FolderDefinition,
	field,
	inspectRow,
	openFolder,
} from './bun.js';
import { hashBytes } from './capture.js';
import { createHistory } from './git/history.js';
import { createNativeGitBackend } from './git/native-backend.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	gitHttpFetch,
	scratch,
} from './git-http.test-support.js';
import { createNativeFileBoundary } from './native-store.js';
import { useWebLocks } from './web-locks.test-support.js';

const openNativeFolder = async <const TDefinition extends FolderDefinition>(
	options: DirectoryFolderOptions<TDefinition>,
) => expectOk(await openFolder(options));

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
type Todos = Folder<typeof definition>;

const author = { name: 'App', email: 'app@example.test' };
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeAll(() => {
	// Keep the developer's global Git configuration (hooks, signing) out of these runs.
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	globalThis.fetch = originalFetch;
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});

/** Wait for the commit attempt a save started, and its push, to settle. */
async function settled(folder: Todos) {
	for (let index = 0; index < 400; index++) {
		const { activity } = folder.git.snapshot;
		if (!activity.commit.active && !activity.push.active) return;
		await Bun.sleep(10);
	}
	throw new Error('Git work did not settle');
}

describe('native folder', () => {
	test('an existing non-main HEAD refuses history changes while file saves remain available', async () => {
		const root = await scratch('native-legacy-branch-');
		await git(root, 'init', '--quiet', '--initial-branch=backup');
		await writeFile(join(root, 'legacy.txt'), 'previous history');
		await git(root, 'add', 'legacy.txt');
		await git(root, 'commit', '--quiet', '-m', 'Previous history');
		const previous = await git(root, 'rev-parse', 'HEAD');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author, commitOnEdit: false },
		});
		try {
			expectOk(await folder.files.create('saved.txt', 'saved'));
			expect(await folder.git.commit()).toMatchObject({
				status: 'blocked',
				reason: 'HEAD is not on main',
			});
			expect(await git(root, 'rev-parse', 'HEAD')).toBe(previous);
			expect(
				await git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads'),
			).toBe('refs/heads/backup');
			expect(await readFile(join(root, 'saved.txt'), 'utf8')).toBe('saved');
		} finally {
			await folder.close();
		}
	});

	test('saves ordinary files, commits automatically, and keeps the native index consistent', async () => {
		const root = await scratch('native-folder-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		const { data: created, error: createError } =
			await folder.tables.todos.create({
				stem: 'walk',
				fields: { title: 'Walk', done: false },
				body: 'Around the block.\n',
			});
		expect(createError).toBeNull();
		expect(await readFile(join(root, 'todos/walk.md'), 'utf8')).toBe(
			created!.text,
		);
		await settled(folder);
		expect(await git(root, 'log', '--format=%s')).toBe('Add todos/walk.md');
		expect(await git(root, 'status', '--porcelain')).toBe('');

		// An external edit is preserved when a command updates current content.
		await writeFile(
			join(root, 'todos/walk.md'),
			created!.text.replace('Walk', 'Run'),
		);
		const current = expectOk(await folder.tables.todos.get('walk'))!;
		expect(current.fields.title).toBe('Run');
		const { data: done, error: updateError } = await folder.tables.todos.update(
			'walk',
			{ fields: { done: true } },
			{},
		);
		expect(updateError).toBeNull();
		expect(inspectRow(definition.tables.todos, done!.text).fields).toEqual({
			title: 'Run',
			done: true,
		});
		await settled(folder);
		expect(await git(root, 'log', '-1', '--format=%s')).toBe(
			'Update todos/walk.md',
		);
		expect(await git(root, 'status', '--porcelain')).toBe('');
		expect(await git(root, 'show', 'HEAD:todos/walk.md')).toContain(
			'done: true',
		);
		await folder.close();
	});

	test('a complete file save checkpoints external bytes and refuses staged authoring', async () => {
		const root = await scratch('native-content-policy-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		try {
			await writeFile(join(root, 'external.md'), 'external');
			expect(folder.git.snapshot.lastCommit).toBeUndefined();
			expect(folder.git.snapshot.activity.commit).toEqual({ active: false });
			expectOk(await folder.files.create('saved.md', 'saved'));
			await settled(folder);
			expect(await git(root, 'show', 'HEAD:external.md')).toBe('external');
			expect(await git(root, 'show', 'HEAD:saved.md')).toBe('saved');
			expect(expectErr(await folder.git.stage('all')).name).toBe(
				'AutomaticHistory',
			);
			expect(expectErr(await folder.git.commitStaged('Authored')).name).toBe(
				'AutomaticHistory',
			);
			expect(await git(root, 'status', '--porcelain')).toBe('');
		} finally {
			await folder.close();
		}
	});

	test('an unsupported definition is refused before a repository is initialized', async () => {
		const root = await scratch('native-refused-');
		const withCodec: DataSchema = {
			kv: {},
			tables: {
				notes: defineTable({
					fields: { title: field.string() },
					body: { encode: () => '', decode: () => undefined },
				}),
			},
		};
		const refused = expectErr(
			await openFolder({ root, definition: withCodec, git: { author } }),
		);
		expect(refused.name).toBe('InvalidDefinition');
		expect(refused.message).toContain('body codec');
		expect(await readdir(root)).toEqual([]);
	});

	test('a root that is not a directory is a returned refusal, and the handle says where it opened', async () => {
		const root = await scratch('native-root-');
		await writeFile(join(root, 'file'), 'not a directory');
		const refused = expectErr(
			await openFolder({
				root: join(root, 'file'),
				definition,
				git: { author },
			}),
		);
		expect(refused.name).toBe('InvalidRoot');
		const missing = expectErr(
			await openFolder({
				root: join(root, 'absent'),
				definition,
				git: { author },
			}),
		);
		expect(missing.name).toBe('InvalidRoot');

		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		expect(folder.location.kind).toBe('directory');
		expect(folder.location).toEqual({
			kind: 'directory',
			root: await realpath(root),
		});
		await folder.close();
	});

	test('literal lookup: a stem does not alias a differently cased file', async () => {
		const root = await scratch('native-case-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author, commitOnEdit: false },
		});
		await folder.files.create(
			'todos/Plan.md',
			'---\ntitle: P\ndone: false\n---\n',
		);
		expect((await folder.tables.todos.get('Plan')).data?.stem).toBe('Plan');
		expect((await folder.tables.todos.get('plan')).data).toBeUndefined();

		// Creating the other spelling is this filesystem's question, not a
		// naming rule's: it is refused exactly when both names are one file.
		const oneFile = await readFile(join(root, 'todos/plan.md')).then(
			() => true,
			() => false,
		);
		const other = await folder.tables.todos.create({
			stem: 'plan',
			fields: { title: 'Q', done: false },
		});
		const plan = expectOk(await folder.tables.todos.get('Plan'))!;
		const moved = await folder.tables.todos.rename('Plan', 'PLAN', {
			expectedSha256: plan.sha256,
		});
		if (oneFile) {
			expect(expectErr(other)).toMatchObject({
				name: 'Exists',
				path: 'todos/plan.md',
			});
			expect(expectErr(moved).name).toBe('Exists');
			expect(await readdir(join(root, 'todos'))).toEqual(['Plan.md']);
			expect(await readFile(join(root, 'todos/Plan.md'), 'utf8')).toBe(
				plan.text,
			);
		} else {
			expectOk(other);
			expectOk(moved);
			expect((await readdir(join(root, 'todos'))).sort()).toEqual([
				'PLAN.md',
				'plan.md',
			]);
		}
		await folder.close();
	});

	test('literal stems are rows on disk: an empty stem, a leading dot, a trailing space, and punctuation', async () => {
		const root = await scratch('native-literal-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author, commitOnEdit: false },
		});
		const stems = ['', '.hidden', 'trailing ', 'a: b', 'q?*'];
		for (const stem of stems) {
			const created = expectOk(
				await folder.tables.todos.create({
					stem,
					fields: { title: stem, done: false },
				}),
			);
			expect(created.stem).toBe(stem);
			expect(await readFile(join(root, 'todos', `${stem}.md`), 'utf8')).toBe(
				created.text,
			);
			expect(expectOk(await folder.tables.todos.get(stem))).toEqual({
				...created,
				...inspectRow(definition.tables.todos, created.text),
			});
			const updated = expectOk(
				await folder.tables.todos.update(stem, { fields: { done: true } }, {}),
			);
			expect(inspectRow(definition.tables.todos, updated.text)).toMatchObject({
				parseError: undefined,
				issues: [],
			});
		}
		// An uppercase extension is an ordinary file, not a row.
		await writeFile(join(root, 'todos/Loud.MD'), 'not a row');
		const listing = expectOk(await folder.tables.todos.list());
		expect(listing.map((item) => expectOk(item.result).stem).sort()).toEqual(
			[...stems].sort(),
		);
		expect(expectOk(await folder.tables.todos.get('Loud'))).toBeUndefined();

		// Bytes that are not text fail that file alone.
		await writeFile(join(root, 'todos/binary.md'), new Uint8Array([0xff, 0]));
		const withBinary = expectOk(await folder.tables.todos.list());
		expect(withBinary).toHaveLength(stems.length + 1);
		expect(
			expectErr(
				withBinary.find((item) => item.path === 'todos/binary.md')!.result,
			).name,
		).toBe('InvalidUtf8');

		const empty = expectOk(await folder.tables.todos.get(''))!;
		const guard = { expectedSha256: empty.sha256 };
		expectOk(await folder.tables.todos.rename('', 'named', guard));
		expectOk(await folder.tables.todos.delete('named', guard));
		expect(await readdir(join(root, 'todos'))).not.toContain('.md');
		await folder.close();
	});

	test('a row is renamed and deleted alone: existing audio beside it is never moved, removed, or required', async () => {
		const root = await scratch('native-siblings-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author, commitOnEdit: false },
		});
		// Audio recorded under the old model sits beside the row it was saved with.
		const audio = new Uint8Array([1, 2, 3]);
		expectOk(await folder.files.create('todos/take.opus', audio));
		const created = expectOk(
			await folder.tables.todos.create({
				stem: 'take',
				fields: { title: 'Take', done: false },
			}),
		);
		expect(inspectRow(definition.tables.todos, created.text)).toMatchObject({
			parseError: undefined,
			issues: [],
		});

		expectOk(await folder.tables.todos.rename('take', 'take2', {}));
		expect((await readdir(join(root, 'todos'))).sort()).toEqual([
			'take.opus',
			'take2.md',
		]);

		// The audio disappears outside the app. The row does not depend on it.
		await rm(join(root, 'todos/take.opus'));
		expectOk(
			await folder.tables.todos.rename('take2', 'take3', {
				expectedSha256: created.sha256,
			}),
		);
		await writeFile(join(root, 'todos/take3.opus'), audio);
		await writeFile(join(root, 'todos/take3.wav'), audio);

		expectOk(
			await folder.tables.todos.delete('take3', {
				expectedSha256: created.sha256,
			}),
		);
		expect((await readdir(join(root, 'todos'))).sort()).toEqual([
			'take3.opus',
			'take3.wav',
		]);
		expect(
			new Uint8Array(await readFile(join(root, 'todos/take3.opus'))),
		).toEqual(audio);
		await folder.close();
	});

	test('a competing native commit refuses the checkpoint; the branch is never forced', async () => {
		const root = await scratch('native-cas-');
		await git(root, 'init', '--quiet', '--initial-branch=main');
		const boundary = createNativeFileBoundary(root);
		const backend = await createNativeGitBackend({
			root,
			branch: 'main',
			remote: undefined,
			boundary,
		});
		const history = createHistory({
			backend: {
				...backend,
				async casBranch(expected, next) {
					await git(
						root,
						'commit',
						'--quiet',
						'--allow-empty',
						'-m',
						'Competitor',
					);
					return backend.casBranch(expected, next);
				},
			},
			boundary,
			author,
			commitOnEdit: false,
		});
		await writeFile(join(root, 'a.txt'), 'a');
		const outcome = await history.commit();
		expect(outcome.status).toBe('branchMoved');
		expect(await git(root, 'log', '--format=%s')).toBe('Competitor');
		if (outcome.status === 'branchMoved') {
			// The candidate exists as an unreachable object; it was not published.
			expect(await git(root, 'cat-file', '-t', outcome.candidate)).toBe(
				'commit',
			);
			expect(outcome.actual).toBe(await git(root, 'rev-parse', 'HEAD'));
		}
		await history.close();
	});

	test('explicit staging uses real Git commands', async () => {
		const root = await scratch('native-stage-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author, commitOnEdit: false },
		});
		await folder.files.create('a.txt', 'a\n');
		await folder.files.create('b.txt', 'b\n');
		expect((await folder.git.stage(['a.txt'])).error).toBeNull();
		expect((await folder.git.paths()).data).toEqual([
			{ path: 'a.txt', index: 'A', worktree: ' ' },
			{ path: 'b.txt', index: '?', worktree: '?' },
		]);
		const { error: commitError } =
			await folder.git.commitStaged('Stage one file');
		expect(commitError).toBeNull();
		expect(await git(root, 'log', '--format=%s%n%an')).toBe(
			'Stage one file\nApp',
		);
		expect((await folder.git.commitStaged('again')).error?.name).toBe(
			'NothingToCommit',
		);
		await folder.close();
	});
});

describe('browser and native exchange through a real bare repository', () => {
	test('attaching a remote branch preserves local main and exchanges that history', async () => {
		const root = await scratch('exchange-other-branch-');
		const bare = await createBareRemote(root);
		globalThis.fetch = await gitHttpFetch(root);
		const environment = createTestStorage();
		const local = expectOk(
			await openBrowserFolder({
				id: 'attach-backup',
				definition,
				browser: {
					author,
					...browserStorage(environment),
					commitOnEdit: false,
				},
			}),
		);
		expectOk(await local.files.create('local.txt', 'local'));
		expect((await local.git.commit()).status).toBe('committed');
		const first = expectOk(await local.git.log(10))[0]!.oid;
		await local.close();

		const browser = expectOk(
			await openBrowserFolder({
				id: 'attach-backup',
				definition,
				browser: {
					author,
					...browserStorage(environment),
					commitOnEdit: false,
					remote: { url: 'http://git.test/remote.git', branch: 'backup' },
				},
			}),
		);
		try {
			expect(expectOk(await browser.git.log(10))[0]!.oid).toBe(first);
			expectOk(await browser.files.create('second.txt', 'second'));
			expect((await browser.git.commit()).status).toBe('committed');
			expect((await browser.git.push()).status).toBe('pushed');
			expect(await git(bare, 'rev-parse', 'backup^')).toBe(first);
			expect(await git(bare, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
			const second = await git(bare, 'rev-parse', 'backup');
			// isomorphic-git 1.38.5 requires a resolvable advertised HEAD,
			// even when fetching another branch explicitly.
			expect(expectErr(await browser.git.fetch()).message).toContain(
				'Could not find HEAD',
			);
			expect(expectOk(await browser.git.log(10))[0]!.oid).toBe(second);
			await git(bare, 'update-ref', 'refs/heads/main', second);
			expect(expectOk(await browser.git.fetch()).oid).toBe(second);

			const nativeRoot = await scratch('native-other-branch-');
			let native = await openNativeFolder({
				root: nativeRoot,
				definition,
				git: {
					author,
					commitOnEdit: false,
					remote: { url: bare, branch: 'backup' },
				},
			});
			try {
				expect(await git(nativeRoot, 'symbolic-ref', 'HEAD')).toBe(
					'refs/heads/main',
				);
				expect(expectOk(await native.git.fetch()).oid).toBe(second);
				expect(expectOk(await native.git.pullFastForward()).status).toBe(
					'fastForwarded',
				);
				expect(
					await git(nativeRoot, 'rev-parse', 'refs/remotes/origin/backup'),
				).toBe(second);
				expect(
					await git(
						nativeRoot,
						'for-each-ref',
						'--format=%(refname)',
						'refs/heads',
					),
				).toBe('refs/heads/main');
				await native.close();
				native = await openNativeFolder({
					root: nativeRoot,
					definition,
					git: { author, commitOnEdit: false },
				});
				expectOk(await native.files.create('third.txt', 'third'));
				expect((await native.git.commit()).status).toBe('committed');
				const third = await git(nativeRoot, 'rev-parse', 'HEAD');
				await native.close();
				native = await openNativeFolder({
					root: nativeRoot,
					definition,
					git: {
						author,
						commitOnEdit: false,
						remote: { url: bare, branch: 'backup' },
					},
				});
				expect((await native.git.push()).status).toBe('pushed');
				expect(await git(bare, 'rev-parse', 'backup^')).toBe(second);
				expect(expectOk(await browser.git.fetch()).oid).toBe(third);
				expect(expectOk(await browser.git.pullFastForward()).status).toBe(
					'fastForwarded',
				);
				expect((await browser.terminal().exec('git status')).stdout).toContain(
					'## main',
				);
			} finally {
				await native.close();
			}
		} finally {
			await browser.close();
			globalThis.fetch = originalFetch;
		}
	});

	test('browser push, native pull, native push, browser fast-forward', async () => {
		const root = await scratch('exchange-');
		const bare = await createBareRemote(root);
		globalThis.fetch = await gitHttpFetch(root);
		const browserRemote = { url: 'http://git.test/remote.git', branch: 'main' };

		const environment = createTestStorage();
		const browser = expectOk(
			await openBrowserFolder({
				id: 'exchange',
				definition,
				browser: {
					author: { name: 'Browser', email: 'browser@example.test' },
					remote: browserRemote,
					...browserStorage(environment),
				},
			}),
		);
		await browser.tables.todos.create({
			stem: 'first',
			fields: { title: 'First', done: false },
		});
		await settled(browser);
		expect(browser.git.snapshot.lastPush).toBeUndefined();
		expect((await browser.git.push()).status).toBe('pushed');
		expect(await git(bare, 'log', '--format=%s', 'main')).toBe(
			'Add todos/first.md',
		);

		const nativeRoot = join(root, 'native');
		await git(root, 'init', '--quiet', '--initial-branch=main', nativeRoot);
		const native = await openNativeFolder({
			root: nativeRoot,
			definition,
			git: {
				author: { name: 'Native', email: 'native@example.test' },
				remote: { url: bare, branch: 'main' },
			},
		});
		expect((await native.git.fetch()).data?.oid).toBe(
			await git(bare, 'rev-parse', 'main'),
		);
		const { data: pulled, error: pullError } =
			await native.git.pullFastForward();
		expect(pullError).toBeNull();
		expect(pulled?.status).toBe('fastForwarded');
		expect(await git(nativeRoot, 'status', '--porcelain')).toBe('');
		const nativeEntry = expectOk(await native.tables.todos.get('first'))!;
		expect(nativeEntry.fields.title).toBe('First');

		await native.tables.todos.update(
			nativeEntry.stem,
			{
				fields: { done: true },
			},
			{},
		);
		await settled(native);
		expect(native.git.snapshot.lastPush).toBeUndefined();
		expect((await native.git.push()).status).toBe('pushed');
		expect(await git(bare, 'log', '-1', '--format=%s', 'main')).toBe(
			'Update todos/first.md',
		);

		expect((await browser.git.fetch()).error).toBeNull();
		const { data: incoming, error: incomingError } =
			await browser.git.pullFastForward();
		expect(incomingError).toBeNull();
		expect(incoming?.status).toBe('fastForwarded');
		const browserEntry = expectOk(await browser.tables.todos.get('first'))!;
		expect(browserEntry.fields.done).toBe(true);
		expect((await browser.git.status()).data?.changes).toEqual([]);
		expect((await browser.git.paths()).data).toEqual([]);

		// A dirty folder refuses the next fast-forward before writing anything.
		await native.tables.todos.update(
			'first',
			{
				fields: { title: 'Native edit' },
			},
			{},
		);
		await settled(native);
		expect((await native.git.push()).status).toBe('pushed');
		// Another writer publishes without a save request on this handle.
		const external = await rawBrowserFolder({
			id: 'exchange',
			storage: environment,
		});
		const bytes = new TextEncoder().encode('local');
		expectOk(
			await external.boundary.apply([
				{
					kind: 'create',
					path: 'scratch.txt',
					bytes,
					sha256: await hashBytes(bytes),
				},
			]),
		);
		await browser.git.fetch();
		const { error: dirtyError } = await browser.git.pullFastForward();
		expect(dirtyError?.name).toBe('Dirty');
		expect((await browser.tables.todos.get('first')).data!.fields.title).toBe(
			'First',
		);

		// Divergence: the browser commits locally; its push is rejected and pull refuses.
		expect((await browser.git.commit()).status).toBe('committed');
		const push = await browser.git.push();
		expect(push.status).toBe('failed');
		if (push.status === 'failed')
			expect(push.error).toBe(
				"The remote branch 'main' cannot be updated by a fast-forward",
			);
		const { error: divergedError } = await browser.git.pullFastForward();
		expect(divergedError?.name).toBe('Diverged');
		expect((await browser.tables.todos.get('first')).data!.fields.title).toBe(
			'First',
		);

		await browser.close();
		await native.close();
		globalThis.fetch = originalFetch;
	});

	test('an unreachable remote leaves the local commit and reports the push failure', async () => {
		const browser = expectOk(
			await openBrowserFolder({
				id: 'offline',
				definition,
				browser: {
					author,
					remote: { url: 'http://127.0.0.1:9/offline.git', branch: 'main' },
					...testBrowserStorage(),
				},
			}),
		);
		expectOk(await browser.files.create('offline.txt', 'Offline'));
		await settled(browser);
		expect(browser.git.snapshot.lastCommit?.status).toBe('committed');
		expect(browser.git.snapshot.lastPush).toBeUndefined();
		expect((await browser.git.push()).status).toBe('failed');
		expect(browser.git.snapshot.lastPush?.status).toBe('failed');
		const sync = browser.git.snapshot.sync;
		expect(sync.state === 'observed' && sync.value.ahead).toBe(1);
		expect(
			new TextDecoder().decode(
				expectOk(await browser.files.read('offline.txt')).bytes,
			),
		).toBe('Offline');
		await browser.close();
	});
});

// Automatic commits need the shared lock; this runtime has none of its own.
useWebLocks();
