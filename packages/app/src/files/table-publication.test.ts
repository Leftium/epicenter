/**
 * Table Publication Condition Tests
 *
 * A table create, rename, or delete reads its directory once to refuse early
 * with a useful error. That read is only a preflight: another writer can land
 * between it and the batch. These tests land a write in exactly that window
 * and require the operation to check the same conditions again where the
 * batch publishes, before any of its changes.
 *
 * The browser interloper writes through a second database handle, so only the
 * shared readwrite transaction can order it. The native interloper writes
 * through the same boundary, so only the shared batch queue can.
 *
 * Key behaviors:
 * - Delete refuses, and removes nothing, when a second same-stem attachment
 *   appeared after its directory check
 * - Rename refuses, and moves nothing, when an attachment appeared at its
 *   source or at its destination after its directory check
 * - Two creates of one stem with different attachment extensions save one
 *   row with one attachment; the loser writes nothing
 * - A refusal requests no history
 * - Unrelated files appearing in the directory refuse nothing, and creates of
 *   different stems that overlap both save
 * - A row whose bytes changed is still an exact-version `Conflict`
 * - A native rename that fails on disk after its row moved is `Partial`
 *
 * See also:
 * - `ownership.test.ts` for the preflight refusals
 * - `native-concurrency.test.ts` for same-version saves through one boundary
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from 'bun:test';
import { realpath, rm } from 'node:fs/promises';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineStore, defineTable, field } from '../index.js';
import type { FileBoundary } from './boundary.js';
import {
	createBrowserFileBoundary,
	openFolderDatabase,
} from './browser-store.js';
import { assembleFolder } from './folder.js';
import { createBrowserGitBackend } from './git/browser-backend.js';
import { createHistory, type History } from './git/history.js';
import { createNativeGitBackend } from './git/native-backend.js';
import { GIT_ENV, scratch } from './git-http.test-support.js';
import { createNativeFileBoundary } from './native-store.js';
import { captureVersion } from './version.js';

const definition = defineStore({
	id: 'so.epicenter.tablepublicationtest',
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
const author = { name: 'App', email: 'app@example.test' };
const encoder = new TextEncoder();
const cleanups: (() => Promise<void>)[] = [];
const originalGlobal = process.env.GIT_CONFIG_GLOBAL;

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
});
afterAll(() => {
	if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function browserStorage() {
	const environment = { indexedDB: new IDBFactory(), IDBKeyRange };
	const name = 'epicenter-folder:table-publication';
	const db = await openFolderDatabase(name, environment);
	const second = await openFolderDatabase(name, environment);
	cleanups.push(async () => {
		db.close();
		second.close();
	});
	const base = createBrowserFileBoundary(db, environment);
	return {
		base,
		// A separate connection: nothing in this process orders it with `base`.
		other: createBrowserFileBoundary(second, environment),
		backend: (_boundary: FileBoundary) =>
			createBrowserGitBackend({
				db,
				environment,
				lockName: 'table-publication',
				branch: 'main',
				remote: undefined,
			}),
	};
}

async function nativeStorage() {
	const root = await realpath(await scratch('table-publication-'));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const base = createNativeFileBoundary(root);
	return {
		base,
		// The same boundary: its writes join the queue the table publishes through.
		other: base,
		backend: (boundary: FileBoundary) =>
			createNativeGitBackend({
				root,
				branch: 'main',
				remote: undefined,
				boundary,
			}),
	};
}

const adapters = { browser: browserStorage, native: nativeStorage };

/**
 * A folder whose table operations see `afterDirectoryRead` run once, right
 * after their preflight directory read returns and before they publish.
 */
async function setup(adapter: keyof typeof adapters) {
	const { base, other, backend } = await adapters[adapter]();
	let afterDirectoryRead: (() => Promise<void>) | undefined;
	const boundary: FileBoundary = {
		...base,
		async children(directory) {
			const result = await base.children(directory);
			const hook = afterDirectoryRead;
			afterDirectoryRead = undefined;
			await hook?.();
			return result;
		},
	};
	const real = createHistory({
		backend: await backend(boundary),
		boundary,
		author,
		commitOnEdit: true,
	});
	const requested = { edits: 0, commits: 0 };
	const history: History = Object.assign(Object.create(real), {
		noteEdit() {
			requested.edits++;
			real.noteEdit();
		},
		requestAutomaticCommit() {
			requested.commits++;
			real.requestAutomaticCommit();
		},
	});
	const folder = assembleFolder({
		definition,
		boundary,
		history,
		release: async () => {},
	});
	cleanups.push(() => folder.close());

	return {
		folder,
		todos: folder.tables.todos,
		requested,
		/** Land `work` between the next directory read and its publication. */
		interleave(work: () => Promise<void>) {
			afterDirectoryRead = work;
		},
		/** Hold directory reads until `count` operations have each made theirs. */
		overlap(count: number) {
			let arrived = 0;
			const { promise: all, resolve } = Promise.withResolvers<void>();
			boundary.children = async (directory) => {
				const result = await base.children(directory);
				if (++arrived >= count) resolve();
				await all;
				return result;
			};
		},
		/** A write from the other writer, which requests no history here. */
		async otherWrites(path: string, text: string) {
			const bytes = encoder.encode(text);
			expectOk(
				await other.apply([
					{
						kind: 'write',
						path,
						bytes,
						version: await captureVersion(bytes),
						expected: 'any',
					},
				]),
			);
		},
		async files() {
			const found = await base.children('todos');
			return found.error ? [] : found.data.files;
		},
	};
}

async function row(
	todos: Awaited<ReturnType<typeof setup>>['todos'],
	stem: string,
	extension?: string,
) {
	return expectOk(
		await todos.create({
			stem,
			fields: { title: stem, done: false },
			attachment:
				extension === undefined
					? undefined
					: { extension, bytes: new Uint8Array([1, 2, 3]) },
		}),
	);
}

for (const adapter of ['browser', 'native'] as const) {
	describe(`${adapter} table publication`, () => {
		test('delete refuses a second same-stem attachment that landed after its directory check', async () => {
			const { todos, requested, interleave, otherWrites, files } =
				await setup(adapter);
			const entry = await row(todos, 'take', 'png');
			const before = { ...requested };
			interleave(() => otherWrites('todos/take.jpg', 'late'));

			const refused = expectErr(await todos.delete(entry));

			expect(refused.name).toBe('AmbiguousAttachment');
			if (refused.name !== 'AmbiguousAttachment') return;
			expect(refused.candidates).toEqual(['todos/take.jpg', 'todos/take.png']);
			expect(await files()).toEqual(['take.jpg', 'take.md', 'take.png']);
			expect(requested).toEqual(before);
		});

		test('rename refuses an attachment that landed at its destination after its directory check', async () => {
			const { todos, requested, interleave, otherWrites, files } =
				await setup(adapter);
			const entry = await row(todos, 'old');
			const before = { ...requested };
			interleave(() => otherWrites('todos/new.png', 'late'));

			const refused = expectErr(await todos.rename(entry, 'new'));

			expect(refused.name).toBe('Exists');
			if (refused.name !== 'Exists') return;
			expect(refused.path).toBe('todos/new.png');
			expect(await files()).toEqual(['new.png', 'old.md']);
			expect(requested).toEqual(before);
		});

		test('rename refuses an attachment that landed at its source after its directory check', async () => {
			const { todos, requested, interleave, otherWrites, files } =
				await setup(adapter);
			const entry = await row(todos, 'old');
			const before = { ...requested };
			interleave(() => otherWrites('todos/old.png', 'late'));

			const refused = expectErr(await todos.rename(entry, 'new'));

			expect(refused.name).toBe('AmbiguousAttachment');
			expect(await files()).toEqual(['old.md', 'old.png']);
			expect(requested).toEqual(before);
		});

		test('two creates of one stem with different attachments save one row and one attachment', async () => {
			const { todos, requested, overlap, files } = await setup(adapter);
			overlap(2);

			const results = await Promise.all(
				['png', 'jpg'].map((extension) =>
					todos.create({
						stem: 'take',
						fields: { title: 'Take', done: false },
						attachment: { extension, bytes: new Uint8Array([1, 2, 3]) },
					}),
				),
			);

			const firstWon = results[0]!.error === null;
			const saved = expectOk(firstWon ? results[0]! : results[1]!);
			const refused = expectErr(firstWon ? results[1]! : results[0]!);
			expect(refused.name).toBe('Exists');
			expect(saved.attachment).toBe(`todos/take.${firstWon ? 'png' : 'jpg'}`);
			expect(await files()).toEqual(
				['take.md', `take.${firstWon ? 'png' : 'jpg'}`].sort(),
			);
			const reread = expectOk(await todos.get('take'));
			expect(reread?.attachment).toBe(saved.attachment);
			expect(reread?.issues).toBeUndefined();
			expect(requested).toEqual({ edits: 1, commits: 1 });
		});

		test('unrelated files that land after the directory check refuse nothing', async () => {
			const { todos, interleave, otherWrites, files } = await setup(adapter);
			const removing = await row(todos, 'gone', 'png');
			const renaming = await row(todos, 'old', 'png');
			const unrelated = async (stem: string) => {
				await otherWrites(
					`todos/${stem}.md`,
					'---\ntitle: x\ndone: false\n---\n',
				);
				await otherWrites(`todos/${stem}.png`, 'unrelated');
			};

			interleave(() => unrelated('first'));
			expect(expectOk(await todos.delete(removing)).removed).toEqual([
				'todos/gone.md',
				'todos/gone.png',
			]);
			interleave(() => unrelated('second'));
			expect(expectOk(await todos.rename(renaming, 'new')).attachment).toBe(
				'todos/new.png',
			);
			interleave(() => unrelated('third'));
			expect((await row(todos, 'made', 'png')).attachment).toBe(
				'todos/made.png',
			);

			expect(await files()).toEqual(
				[
					...['first', 'second', 'third', 'new', 'made'].flatMap((stem) => [
						`${stem}.md`,
						`${stem}.png`,
					]),
				].sort(),
			);
		});

		test('creates of different stems that overlap both save', async () => {
			const { todos, overlap, files } = await setup(adapter);
			overlap(2);

			const results = await Promise.all([
				todos.create({ stem: 'one', fields: { title: 'One', done: false } }),
				todos.create({ stem: 'two', fields: { title: 'Two', done: false } }),
			]);

			for (const result of results) expectOk(result);
			expect(await files()).toEqual(['one.md', 'two.md']);
		});

		test('a row whose bytes changed after the directory check is an exact-version conflict', async () => {
			const { todos, requested, interleave, otherWrites, files } =
				await setup(adapter);
			const entry = await row(todos, 'take', 'png');
			const before = { ...requested };
			const changed = '---\ntitle: Changed\ndone: true\n---\n';
			interleave(() => otherWrites('todos/take.md', changed));

			const refused = expectErr(await todos.delete(entry));

			expect(refused.name).toBe('Conflict');
			if (refused.name !== 'Conflict') return;
			expect(refused.path).toBe('todos/take.md');
			expect(refused.expected).toEqual(entry.version);
			expect(refused.actual).toEqual(
				await captureVersion(encoder.encode(changed)),
			);
			expect(await files()).toEqual(['take.md', 'take.png']);
			expect(requested).toEqual(before);
		});
	});
}

test('a native rename that fails on disk after its row moved is Partial and requests no commit', async () => {
	const { todos, requested, files } = await setup('native');
	const entry = await row(todos, 'old', 'jpeg');
	const before = { ...requested };
	// `<stem>.md` is exactly the 255-byte filename limit, so the row moves and
	// the longer `<stem>.jpeg` is refused by the filesystem itself.
	const longest = 'n'.repeat(252);

	const partial = expectErr(await todos.rename(entry, longest));

	expect(partial.name).toBe('Partial');
	if (partial.name !== 'Partial') return;
	expect(partial.applied).toEqual([
		{ kind: 'move', from: 'todos/old.md', to: `todos/${longest}.md` },
	]);
	expect(partial.failed).toEqual({
		kind: 'move',
		from: 'todos/old.jpeg',
		to: `todos/${longest}.jpeg`,
	});
	expect(partial.error.name).toBe('Io');
	expect(partial.notAttempted).toEqual([]);
	expect(await files()).toEqual([`${longest}.md`, 'old.jpeg']);
	expect(requested).toEqual({
		edits: before.edits + 1,
		commits: before.commits,
	});
});
