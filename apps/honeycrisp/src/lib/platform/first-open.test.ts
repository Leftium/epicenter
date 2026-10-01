/**
 * Folder Setup Tests
 *
 * Runs `setUpFolder` against real directories and the real `git`, through
 * the folder package's directory opener. The folder is opened first, as the
 * desktop leaf opens it first; setup is the only thing between opening and
 * showing the notes.
 *
 * Key behaviors:
 * - An existing folder is opened without changing a byte, a modification
 *   time, or anything in its repository, born or unborn
 * - A missing layout is created, and the default `kv.json` is its first commit
 * - A `kv.json` that appears first is kept, and nothing is retried
 * - A read that fails for any reason but absence writes nothing
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFolder } from '@epicenter/folder/bun';
import { honeycrispDefinition } from '../data.js';
import { setUpFolder } from './first-open.js';
import type { NotesFolder } from './types.js';

// Real git processes; generous under a loaded machine.
setDefaultTimeout(60_000);

const TABLES = Object.keys(honeycrispDefinition.tables);
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function until(check: () => boolean, what: string) {
	for (let attempt = 0; attempt < 3000; attempt += 1) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

async function directory() {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'honeycrisp-setup-')),
	);
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const git = (...args: string[]) =>
		spawnSync('git', args, { cwd: root, encoding: 'utf8' });
	return { root, git };
}

async function open(root: string) {
	const opened = await openFolder({
		root,
		definition: honeycrispDefinition,
		git: { author: { name: 'Honeycrisp', email: 'honeycrisp@localhost' } },
	});
	if (opened.error) throw new Error(opened.error.message);
	const folder = opened.data;
	cleanup.push(() => folder.close());
	return folder;
}

/** Every file under `directory` with its size and modification time. */
async function fingerprint(directory: string): Promise<string[]> {
	const lines: string[] = [];
	for (const entry of await readdir(directory, {
		recursive: true,
		withFileTypes: true,
	})) {
		const path = join(entry.parentPath, entry.name);
		const stats = await stat(path);
		lines.push(
			entry.isDirectory()
				? `${path}/`
				: `${path} ${stats.size} ${stats.mtimeMs}`,
		);
	}
	return lines.sort();
}

const NOTE =
	'---\r\ntitle:   "Spaced"  # keep\r\nextra: [1, 2]\r\n---\r\n\r\n* a\r\n';
const KV = '{"kept":true}';

/** A folder someone already has: a note, settings, and both table directories. */
async function existing() {
	const { root, git } = await directory();
	for (const table of TABLES) await mkdir(join(root, table));
	await writeFile(join(root, 'notes', 'old.md'), NOTE);
	await writeFile(join(root, 'kv.json'), KV);
	return { root, git };
}

// ============================================================================
// Opening an existing folder
// ============================================================================

describe('an existing folder', () => {
	test('with history is opened without changing its files or its repository', async () => {
		const { root, git } = await existing();
		git('init', '--quiet', '--initial-branch=main');
		git('add', '--all');
		const committed = git(
			'-c',
			'user.name=Someone',
			'-c',
			'user.email=someone@example.com',
			'-c',
			'commit.gpgsign=false',
			'commit',
			'--quiet',
			'--message',
			'Their own first commit',
		);
		expect(committed.stderr).toBe('');
		expect(committed.status).toBe(0);
		// Opening may refresh Git's private index; what must not move is the
		// work, the branch, and the objects.
		const state = async () => ({
			files: (await fingerprint(root)).filter(
				(line) => !line.includes('/.git/') && !line.endsWith('/.git/'),
			),
			head: git('rev-parse', 'HEAD').stdout,
			refs: git('for-each-ref').stdout,
			objects: git('count-objects', '-v').stdout,
			log: git('log', '--format=%H %s').stdout,
		});
		const before = await state();
		const folder = await open(root);
		await setUpFolder(folder.files, TABLES);
		// Long enough for a commit to have been made, had one been requested.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(await state()).toEqual(before);
		expect(before.log).toContain('Their own first commit');
		expect(folder.git.snapshot.lastCommit).toBeUndefined();
		expect(await readFile(join(root, 'notes', 'old.md'), 'utf8')).toBe(NOTE);
		expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe(KV);
	});

	test('with an unborn repository stays unborn', async () => {
		const { root, git } = await existing();
		git('init', '--quiet', '--initial-branch=main');
		const files = (await fingerprint(root)).filter(
			(line) => !line.includes('/.git'),
		);
		const folder = await open(root);
		await setUpFolder(folder.files, TABLES);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(git('rev-parse', '--verify', '--quiet', 'HEAD').status).not.toBe(0);
		expect(git('for-each-ref').stdout).toBe('');
		expect(git('count-objects', '-v').stdout).toContain('count: 0');
		expect(folder.git.snapshot.lastCommit).toBeUndefined();
		expect(
			(await fingerprint(root)).filter((line) => !line.includes('/.git')),
		).toEqual(files);
	});

	test('missing one table directory gains that directory and nothing else', async () => {
		const { root, git } = await directory();
		await mkdir(join(root, 'notes'));
		await writeFile(join(root, 'notes', 'old.md'), NOTE);
		await writeFile(join(root, 'kv.json'), KV);
		const kept = [
			await stat(join(root, 'notes', 'old.md')),
			await stat(join(root, 'kv.json')),
		].map((stats) => stats.mtimeMs);
		const folder = await open(root);
		await setUpFolder(folder.files, TABLES);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect((await stat(join(root, 'folders'))).isDirectory()).toBe(true);
		expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe(KV);
		expect(
			[
				await stat(join(root, 'notes', 'old.md')),
				await stat(join(root, 'kv.json')),
			].map((stats) => stats.mtimeMs),
		).toEqual(kept);
		// An empty directory is not a save: nothing was committed.
		expect(git('rev-parse', '--verify', '--quiet', 'HEAD').status).not.toBe(0);
	});
});

// ============================================================================
// A new folder
// ============================================================================

describe('a new folder', () => {
	test('gets its table directories, and its default settings are the first commit', async () => {
		const { root, git } = await directory();
		const folder = await open(root);
		await setUpFolder(folder.files, TABLES);
		for (const table of TABLES)
			expect((await stat(join(root, table))).isDirectory()).toBe(true);
		expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe('{}\n');
		// The commit follows the save by the folder's own policy.
		await until(
			() => git('rev-list', '--count', 'HEAD').stdout.trim() === '1',
			'the first commit',
		);
		expect(git('log', '--format=%s').stdout.trim()).toBe('Add kv.json');
		// Opening it again is opening an existing folder.
		const head = git('rev-parse', 'HEAD').stdout;
		await setUpFolder(folder.files, TABLES);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(git('rev-parse', 'HEAD').stdout).toBe(head);
	});

	test('is set up even when the first commit cannot be recorded', async () => {
		const { root, git } = await directory();
		const folder = await open(root);
		// Another Git process holds the branch: the commit fails, the save stands.
		await mkdir(join(root, '.git', 'refs', 'heads'), { recursive: true });
		await writeFile(join(root, '.git', 'refs', 'heads', 'main.lock'), '');
		await setUpFolder(folder.files, TABLES);
		expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe('{}\n');
		await until(
			() => folder.git.snapshot.lastCommit?.status === 'failed',
			'the failed commit',
		);
		expect(git('rev-parse', '--verify', '--quiet', 'HEAD').status).not.toBe(0);
	});
});

// ============================================================================
// Races and refusals
// ============================================================================

describe('races and refusals', () => {
	test('settings created by another writer after the look are kept', async () => {
		const { root } = await directory();
		const folder = await open(root);
		let writes = 0;
		await setUpFolder(
			{
				list: () => folder.files.list(),
				mkdir: (path) => folder.files.mkdir(path),
				async read(path) {
					const found = await folder.files.read(path);
					// The other writer lands between the look and the write.
					await writeFile(join(root, 'kv.json'), KV);
					return found;
				},
				create(...args) {
					writes += 1;
					return folder.files.create(...args);
				},
			},
			TABLES,
		);
		expect(writes).toBe(1);
		expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe(KV);
	});

	/** A files surface that answers from fixed results and counts its writes. */
	function scripted(results: {
		read: { name: string; message: string } | null;
		write?: { name: string; message: string } | null;
		mkdir?: { name: string; message: string } | null;
	}) {
		const calls = { write: 0, mkdir: [] as string[] };
		const reply = (error: { name: string; message: string } | null) =>
			error === null ? { data: undefined, error: null } : { data: null, error };
		const files = {
			list: async () => ({
				data: { files: [], directories: ['notes'] },
				error: null,
			}),
			mkdir: async (path: string) => {
				calls.mkdir.push(path);
				return reply(results.mkdir ?? null);
			},
			read: async () => reply(results.read),
			create: async () => {
				calls.write += 1;
				return reply(results.write ?? null);
			},
		} as unknown as NotesFolder['files'];
		return { files, calls };
	}

	test('a write whose outcome is unknown is reported and not tried again', async () => {
		const { files, calls } = scripted({
			read: { name: 'NotFound', message: 'kv.json was not found' },
			write: { name: 'Unconfirmed', message: 'The reply was lost' },
		});
		await expect(setUpFolder(files, TABLES)).rejects.toThrow(
			'The notes folder could not be set up: The reply was lost',
		);
		expect(calls.write).toBe(1);
	});

	test('a read that fails for any reason but absence writes nothing', async () => {
		for (const name of ['Io', 'NotAFile', 'Unconfirmed', 'Closed']) {
			const { files, calls } = scripted({
				read: { name, message: `${name} while reading` },
			});
			await expect(setUpFolder(files, TABLES)).rejects.toThrow(
				`${name} while reading`,
			);
			expect(calls.write).toBe(0);
		}
	});

	test('a table directory that cannot be made stops before the settings are touched', async () => {
		const { files, calls } = scripted({
			read: { name: 'NotFound', message: 'kv.json was not found' },
			mkdir: { name: 'Io', message: 'Read-only file system' },
		});
		await expect(setUpFolder(files, TABLES)).rejects.toThrow(
			'Read-only file system',
		);
		// Only the missing table was attempted; `notes` was already listed.
		expect(calls.mkdir).toEqual(['folders']);
		expect(calls.write).toBe(0);
	});

	test('a folder that cannot be listed is not changed', async () => {
		const { files, calls } = scripted({ read: null });
		files.list = async () =>
			({
				data: null,
				error: { name: 'Io', message: 'Permission denied' },
			}) as unknown as Awaited<ReturnType<NotesFolder['files']['list']>>;
		await expect(setUpFolder(files, TABLES)).rejects.toThrow(
			'Permission denied',
		);
		expect(calls.mkdir).toEqual([]);
		expect(calls.write).toBe(0);
	});
});
