/**
 * Folder Host Tests
 *
 * Opens a real temporary directory with the real host and reaches it the way
 * the page does: the bridge transport and remote folder, with the host's
 * `fetch` handler in place of a socket. Git is the real `git`.
 *
 * Key behaviors:
 * - The directory gets its layout and a repository; existing files are untouched
 * - Requests without the token, or for another host or origin, are refused
 * - Reading a note never rewrites it; an edit keeps unknown frontmatter and comments
 * - A content save requests a commit and does not wait for it
 * - An external edit is announced, and a stale save is refused
 * - Held, delayed, and failed saves and failed commits behave as injected
 * - The terminal runs in the same directory with the real git
 */
import '../src/lib/svelte-modules.test-support.js';
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstantString } from '@epicenter/app/field';
import { expectOk } from 'wellcrafted/testing';
import type { BridgeEvent } from '../src/lib/bridge/contract.js';
import { createBridgeTransport } from '../src/lib/bridge/folder-client.js';
import { openBridgeNotesHost } from '../src/lib/bridge/notes-host.js';
import type { NoteEntry } from '../src/lib/data.js';
import { applyRichBody } from '../src/lib/note-source.js';
import { createFolderHost, type FolderHostOptions } from './serve.js';

const { createDraft } = await import('../src/lib/draft.svelte.ts');

// Real git processes; generous under a loaded machine.
setDefaultTimeout(60_000);

const TOKEN = 'test-token-0123456789';
const ORIGIN = 'http://127.0.0.1:4999';
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function until(check: () => boolean | Promise<boolean>, what: string) {
	for (let attempt = 0; attempt < 3000; attempt += 1) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

async function open(options: Partial<FolderHostOptions> = {}) {
	const root =
		options.root ?? (await mkdtemp(join(tmpdir(), 'honeycrisp-host-')));
	const shell: Record<string, unknown>[] = [];
	const host = await createFolderHost({
		root,
		token: TOKEN,
		toShell: (message) => shell.push(message),
		// The tests compare on demand; the timer would only add noise.
		watchIntervalMs: 60_000,
		...options,
	});
	host.bind(ORIGIN);
	const send = (request: Request) => {
		const headers = new Headers(request.headers);
		headers.set('host', new URL(ORIGIN).host);
		return host.fetch(new Request(request, { headers }));
	};
	const transport = createBridgeTransport({
		origin: ORIGIN,
		token: TOKEN,
		fetch: send,
		retryMs: 5,
	});
	const notes = await openBridgeNotesHost(transport);
	cleanup.push(async () => {
		await notes.close();
		await host.close();
		if (options.root === undefined)
			await rm(root, { recursive: true, force: true });
	});
	const git = (...args: string[]) =>
		spawnSync('git', args, { cwd: host.root, encoding: 'utf8' }).stdout.trim();
	/** Wait until history holds exactly `count` commits (the layout commit is the first). */
	const commits = (count: number) =>
		until(
			() => git('rev-list', '--count', 'HEAD') === String(count),
			`${count} commits`,
		);
	return {
		host,
		notes,
		folder: notes.folder,
		root: host.root,
		shell,
		send,
		git,
		commits,
		transport,
	};
}

const fields = (title: string) => ({
	folderId: null,
	title,
	pinned: false,
	createdAt: '2026-10-01T00:00:00.000Z' as InstantString,
	updatedAt: '2026-10-01T00:00:00.000Z' as InstantString,
	deletedAt: null,
});

async function createNote(
	folder: Awaited<ReturnType<typeof open>>['folder'],
	title = 'First',
) {
	const created = await folder.tables.notes.create({
		fields: fields(title),
		body: 'Hello\n',
	});
	if (created.error) throw new Error(created.error.message);
	return created.data as NoteEntry;
}

describe('the directory', () => {
	test('a fresh root gets its layout and a repository', async () => {
		const { root } = await open();
		expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe('{}\n');
		expect((await stat(join(root, 'notes'))).isDirectory()).toBe(true);
		expect((await stat(join(root, 'folders'))).isDirectory()).toBe(true);
		expect((await stat(join(root, '.git', 'HEAD'))).isFile()).toBe(true);
		expect(
			spawnSync('git', ['log', '--format=%s'], {
				cwd: root,
				encoding: 'utf8',
			}).stdout.trim(),
		).toBe('Add kv.json');
	});

	test('an existing root is opened as it is', async () => {
		const root = await mkdtemp(join(tmpdir(), 'honeycrisp-existing-'));
		cleanup.push(() => rm(root, { recursive: true, force: true }));
		await mkdir(join(root, 'notes'));
		await writeFile(join(root, 'kv.json'), '{"kept":true}');
		const source = '---\ntitle: Old\n---\nbody\n';
		await writeFile(join(root, 'notes', 'old.md'), source);
		const { folder } = await open({ root });
		const listed = await folder.tables.notes.list();
		expect(listed.data?.entries.map((entry) => entry.path)).toEqual([
			'notes/old.md',
		]);
		expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe('{"kept":true}');
		expect(await readFile(join(root, 'notes', 'old.md'), 'utf8')).toBe(source);
	});
});

describe('the boundary', () => {
	test('a request without the token is refused', async () => {
		const { send } = await open();
		const response = await send(
			new Request(`${ORIGIN}/bridge/call`, {
				method: 'POST',
				body: JSON.stringify({ path: ['files', 'list'], args: [] }),
			}),
		);
		expect(response.status).toBe(401);
	});

	test('another host name or origin is refused', async () => {
		const { host } = await open();
		const headers = { authorization: `Bearer ${TOKEN}` };
		const rebinding = await host.fetch(
			new Request(`${ORIGIN}/bridge/events`, {
				headers: { ...headers, host: 'evil.example:4999' },
			}),
		);
		expect(rebinding.status).toBe(421);
		const foreign = await host.fetch(
			new Request(`${ORIGIN}/bridge/events`, {
				headers: {
					...headers,
					host: '127.0.0.1:4999',
					origin: 'https://evil.example',
				},
			}),
		);
		expect(foreign.status).toBe(403);
	});

	test('a path outside the allowlist is a fault', async () => {
		const { send } = await open();
		for (const path of [
			['close'],
			['git', 'push'],
			['tables', 'secrets', 'list'],
			['files', 'constructor'],
		]) {
			const response = await send(
				new Request(`${ORIGIN}/bridge/call`, {
					method: 'POST',
					headers: { authorization: `Bearer ${TOKEN}` },
					body: JSON.stringify({ path, args: [] }),
				}),
			);
			expect(await response.json()).toEqual({
				fault: `Not a folder method: ${JSON.stringify(path)}`,
			});
		}
	});

	test('a file path cannot leave the directory', async () => {
		const { folder } = await open();
		const read = await folder.files.read('../outside.txt');
		expect(read.error?.name).toBe('InvalidPath');
		const written = await folder.files.write('.git/config', 'x', {
			expected: 'any',
		});
		expect(written.error?.name).toBe('InvalidPath');
	});

	test('fault injection is refused unless the host enabled it', async () => {
		const { notes, send } = await open();
		expect(notes.faults).toBeUndefined();
		const response = await send(
			new Request(`${ORIGIN}/bridge/app`, {
				method: 'POST',
				headers: { authorization: `Bearer ${TOKEN}` },
				body: JSON.stringify({ op: 'setFaults', faults: { failSaves: 1 } }),
			}),
		);
		expect(await response.json()).toEqual({
			fault: 'Fault injection is not enabled for this folder.',
		});
	});
});

describe('notes are files', () => {
	test('file saves, moves, and removals request automatic history through the bridge', async () => {
		const { folder, root, git, commits } = await open();
		const created = expectOk(
			await folder.files.write('references/example.md', 'Example\n', {
				expected: 'absent',
			}),
		);
		await commits(2);
		expect(git('show', 'HEAD:references/example.md')).toBe('Example');
		expectOk(
			await folder.files.move(
				'references/example.md',
				'references/renamed.md',
				{
					expected: created,
				},
			),
		);
		await commits(3);
		expect(git('ls-tree', '-r', '--name-only', 'HEAD')).toContain(
			'references/renamed.md',
		);
		expect(await readFile(join(root, 'references/renamed.md'), 'utf8')).toBe(
			'Example\n',
		);
		expectOk(
			await folder.files.remove('references/renamed.md', {
				expected: created,
			}),
		);
		await commits(4);
		expect(git('ls-tree', '-r', '--name-only', 'HEAD')).not.toContain(
			'references/',
		);
	});

	test('a file save survives an automatic history failure', async () => {
		const { folder, notes, root } = await open({ faults: {} });
		await notes.faults!.set({ failCommits: 1 });
		expectOk(
			await folder.files.write('SKILL.md', 'Instructions\n', {
				expected: 'absent',
			}),
		);
		expect(await readFile(join(root, 'SKILL.md'), 'utf8')).toBe(
			'Instructions\n',
		);
		await until(
			() => folder.git.snapshot.lastCommit?.status === 'failed',
			'the failed file checkpoint',
		);
	});

	test('the automatic bridge refuses staged authoring', async () => {
		const { transport } = await open();
		for (const [method, args] of [
			['stage', ['all']],
			['commitStaged', ['Manual']],
		] as const) {
			expect(await transport.call(['git', method], args)).toMatchObject({
				error: { name: 'AutomaticHistory' },
			});
		}
	});

	test('creating a note writes one Markdown file and requests a commit', async () => {
		const { folder, root, git, commits } = await open();
		const note = await createNote(folder);
		expect(note.path).toMatch(/^notes\/[0-9a-z]+\.md$/);
		const source = await readFile(join(root, note.path), 'utf8');
		expect(source).toBe(note.source);
		expect(source).toContain('title: First');
		expect(source.endsWith('---\nHello\n')).toBe(true);
		await commits(2);
		expect(git('log', '--format=%s').split('\n')).toEqual([
			`Add ${note.path}`,
			'Add kv.json',
		]);
		// The branch moves first; the index follows in the same pass, and the
		// pass reports once both are done.
		await until(() => {
			const last = folder.git.snapshot.lastCommit;
			return (
				last?.status === 'committed' && last.oid === git('rev-parse', 'HEAD')
			);
		}, 'the commit to be reported');
		expect(folder.git.snapshot.lastCommit).toMatchObject({
			indexWarning: undefined,
		});
		expect(git('--no-optional-locks', 'status', '--porcelain')).toBe('');
	});

	test('listing and reading a note never rewrite it', async () => {
		const { folder, root } = await open();
		const path = join(root, 'notes', 'odd.md');
		const bytes = Buffer.from(
			'---\r\ntitle:   "Spaced"  # keep\r\nextra: [1, 2]\r\n---\r\n\r\n* a\r\n* b\r\n',
		);
		await writeFile(path, bytes);
		const before = await stat(path);
		await folder.tables.notes.list();
		await folder.tables.notes.get('odd');
		await folder.files.read('notes/odd.md');
		expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
		expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
	});

	test('a body edit keeps unknown frontmatter, comments, and key order', async () => {
		const { folder, root } = await open();
		const source = [
			'---',
			'# a comment about this note',
			'custom: { nested: [1, 2] } # trailing comment',
			'title: "Quoted title"',
			'folderId: null',
			'pinned: false',
			'createdAt: "2026-10-01T00:00:00.000Z"',
			'updatedAt: "2026-10-01T00:00:00.000Z"',
			'deletedAt: null',
			'tags:',
			'  - one',
			'---',
			'',
			'Old body',
			'',
		].join('\n');
		await writeFile(join(root, 'notes', 'keep.md'), source);
		const entry = (await folder.tables.notes.get('keep')).data!;
		const next = applyRichBody(
			entry.source,
			'# New\n\n- [x] done',
			'2026-10-02T00:00:00.000Z' as InstantString,
		);
		expect(next.error).toBeNull();
		const written = await folder.tables.notes.writeSource(entry, next.data!);
		expect(written.error).toBeNull();
		expect(await readFile(join(root, 'notes', 'keep.md'), 'utf8')).toBe(
			source
				.replace(
					'updatedAt: "2026-10-01T00:00:00.000Z"',
					'updatedAt: 2026-10-02T00:00:00.000Z',
				)
				.replace('Old body\n', '# New\n\n- [x] done\n'),
		);
	});

	test('moving a note between folders changes a field, not its file', async () => {
		const { folder } = await open();
		const note = await createNote(folder);
		const made = await folder.tables.folders.create({
			fields: { name: 'Work', icon: null },
		});
		const moved = await folder.tables.notes.update(note, {
			fields: { folderId: made.data!.stem! },
		});
		expect(moved.data?.path).toBe(note.path);
		expect(moved.data?.fields.folderId).toBe(made.data!.stem);
	});
});

describe('other writers', () => {
	test('an external edit is announced and a stale save is refused', async () => {
		const { folder, host, notes, root, commits } = await open();
		const note = await createNote(folder);
		let announced = 0;
		notes.onExternalChange(() => {
			announced += 1;
		});
		await commits(2);
		await host.scan();
		const seen = announced;
		await writeFile(
			join(root, note.path),
			note.source.replace('Hello', 'Changed outside'),
		);
		expect(await host.scan()).toBe(true);
		await until(() => announced > seen, 'the files event');
		const stale = await folder.tables.notes.writeSource(
			note,
			note.source.replace('Hello', 'Mine'),
		);
		expect(stale.error?.name).toBe('Conflict');
		expect(await readFile(join(root, note.path), 'utf8')).toContain(
			'Changed outside',
		);
	});

	test('a dirty draft survives an external edit and can save over the reviewed version', async () => {
		const { folder, root } = await open();
		const note = await createNote(folder);
		const read = async () => {
			const found = await folder.tables.notes.get(note.stem!);
			return found.data === undefined || found.data === null
				? ({ kind: 'removed' } as const)
				: ({ kind: 'present', file: found.data as NoteEntry } as const);
		};
		const draft = createDraft<NoteEntry>(
			{
				write: async (accepted, source) => {
					const written = await folder.tables.notes.writeSource(
						accepted,
						source,
					);
					return written.error
						? { data: null, error: written.error }
						: { data: written.data as NoteEntry, error: null };
				},
				read,
			},
			note,
			{ batchMs: null },
		);
		draft.input(note.source.replace('Hello', 'Mine'));
		await writeFile(
			join(root, note.path),
			note.source.replace('Hello', 'Theirs'),
		);
		await draft.save();
		expect(draft.phase).toBe('conflict');
		expect(draft.buffer).toContain('Mine');
		expect(draft.external).toMatchObject({ kind: 'changed' });
		expect(await readFile(join(root, note.path), 'utf8')).toContain('Theirs');
		await draft.saveMine();
		expect(draft.phase).toBe('saved');
		expect(await readFile(join(root, note.path), 'utf8')).toContain('Mine');
	});

	test('a file deleted outside leaves the draft, which can be written back', async () => {
		const { folder, root } = await open();
		const note = await createNote(folder);
		await rm(join(root, note.path));
		const stale = await folder.tables.notes.writeSource(
			note,
			note.source.replace('Hello', 'Mine'),
		);
		expect(stale.error?.name).toBe('Conflict');
		expect((await folder.tables.notes.get(note.stem!)).data).toBeUndefined();
		const restored = await folder.files.write(
			note.path,
			note.source.replace('Hello', 'Mine'),
			{
				expected: 'absent',
			},
		);
		expect(restored.error).toBeNull();
		expect(await readFile(join(root, note.path), 'utf8')).toContain('Mine');
	});

	test('a malformed file stays listed with its issue and its source', async () => {
		const { folder, root } = await open();
		await writeFile(
			join(root, 'notes', 'bad.md'),
			'---\ntitle: *missing\n---\nbody\n',
		);
		await writeFile(
			join(root, 'notes', 'binary.md'),
			new Uint8Array([0xff, 0xfe, 0x00]),
		);
		const listed = (await folder.tables.notes.list()).data!;
		const bad = listed.entries.find((entry) => entry.path === 'notes/bad.md')!;
		expect(bad.issues?.[0]?.kind).toBe('frontmatter');
		expect(bad.source).toContain('*missing');
		expect(listed.unreadable.map((item) => item.path)).toEqual([
			'notes/binary.md',
		]);
		const repaired = await folder.tables.notes.writeSource(
			bad,
			'---\ntitle: Fixed\n---\nbody\n',
		);
		expect(repaired.data?.fields.title).toBe('Fixed');
	});
});

describe('injected faults', () => {
	test('a held save completes only after release, against the file as it is then', async () => {
		const { folder, notes, root } = await open({ faults: {} });
		const note = await createNote(folder);
		expect((await notes.faults!.set({ holdSaves: true })).holdSaves).toBe(true);
		let settled = false;
		const saving = folder.tables.notes
			.writeSource(note, note.source.replace('Hello', 'Held'))
			.then((result) => {
				settled = true;
				return result;
			});
		await until(
			async () => (await notes.faults!.get()).held === 1,
			'the save to be held',
		);
		expect(settled).toBe(false);
		expect(await readFile(join(root, note.path), 'utf8')).toContain('Hello');
		await notes.faults!.set({ holdSaves: false });
		expect((await saving).error).toBeNull();
		expect(await readFile(join(root, note.path), 'utf8')).toContain('Held');
	});

	test('a file changed while a save is held makes that save stale', async () => {
		const { folder, notes, root } = await open({ faults: { holdSaves: true } });
		await notes.faults!.set({ holdSaves: false });
		const note = await createNote(folder);
		await notes.faults!.set({ holdSaves: true });
		const saving = folder.tables.notes.writeSource(
			note,
			note.source.replace('Hello', 'Held'),
		);
		await until(
			async () => (await notes.faults!.get()).held === 1,
			'the save to be held',
		);
		await writeFile(
			join(root, note.path),
			note.source.replace('Hello', 'Outside'),
		);
		await notes.faults!.set({ holdSaves: false });
		expect((await saving).error?.name).toBe('Conflict');
		expect(await readFile(join(root, note.path), 'utf8')).toContain('Outside');
	});

	test('a failed save writes nothing, and the next one succeeds', async () => {
		const { folder, notes, root } = await open({ faults: {} });
		const note = await createNote(folder);
		await notes.faults!.set({ failSaves: 1 });
		const failed = await folder.tables.notes.writeSource(
			note,
			note.source.replace('Hello', 'Mine'),
		);
		expect(failed.error?.message).toContain('injected save failure');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(note.source);
		const retried = await folder.tables.notes.writeSource(
			note,
			note.source.replace('Hello', 'Mine'),
		);
		expect(retried.error).toBeNull();
	});

	test('a failed commit leaves the file saved and is reported as history, not as a save error', async () => {
		const { folder, notes, root, git, commits } = await open({ faults: {} });
		const note = await createNote(folder);
		await commits(2);
		await notes.faults!.set({ failCommits: 1 });
		const saved = await folder.tables.notes.writeSource(
			note,
			note.source.replace('Hello', 'Uncommitted'),
		);
		expect(saved.error).toBeNull();
		expect(await readFile(join(root, note.path), 'utf8')).toContain(
			'Uncommitted',
		);
		await until(
			() => folder.git.snapshot.lastCommit?.status === 'failed',
			'the failed commit',
		);
		expect(git('log', '--format=%s').split('\n')).toHaveLength(2);
		expect(git('--no-optional-locks', 'status', '--porcelain')).toContain(
			note.path,
		);
		// History catches up with the next commit; the save was never undone.
		const outcome = await folder.git.commit();
		expect(outcome.status).toBe('committed');
		expect(git('--no-optional-locks', 'status', '--porcelain')).toBe('');
	});

	test('a real Git failure, with nothing injected, is also history and not a save error', async () => {
		const { folder, root, git, commits } = await open();
		const note = await createNote(folder);
		await commits(2);
		// Another Git process holding the branch lock makes the next commit fail.
		await writeFile(join(root, '.git', 'refs', 'heads', 'main.lock'), '');
		const saved = await folder.tables.notes.writeSource(
			note,
			note.source.replace('Hello', 'Locked out'),
		);
		expect(saved.error).toBeNull();
		await until(
			() => folder.git.snapshot.lastCommit?.status === 'failed',
			'the failed commit',
		);
		expect(await readFile(join(root, note.path), 'utf8')).toContain(
			'Locked out',
		);
		expect(git('rev-list', '--count', 'HEAD')).toBe('2');
		await rm(join(root, '.git', 'refs', 'heads', 'main.lock'));
		expect((await folder.git.commit()).status).toBe('committed');
	});

	test('a delayed save still acknowledges only what it captured', async () => {
		const { folder, notes } = await open({ faults: { saveDelayMs: 40 } });
		await notes.faults!.set({ saveDelayMs: 0 });
		const note = await createNote(folder);
		await notes.faults!.set({ saveDelayMs: 40 });
		const draft = createDraft<NoteEntry>(
			{
				write: async (accepted, source) => {
					const written = await folder.tables.notes.writeSource(
						accepted,
						source,
					);
					return written.error
						? { data: null, error: written.error }
						: { data: written.data as NoteEntry, error: null };
				},
				read: async () => ({ kind: 'removed' }),
			},
			note,
			{ batchMs: null },
		);
		draft.input(note.source.replace('Hello', 'A'));
		const saving = draft.save();
		expect(draft.phase).toBe('saving');
		draft.input(note.source.replace('Hello', 'A and B'));
		await saving;
		expect(draft.accepted.source).toContain('A\n');
		expect(draft.buffer).toContain('A and B');
		expect(draft.dirty).toBe(true);
	});
});

describe('the terminal and history', () => {
	test('commands run in the same directory with the real git', async () => {
		const { folder, notes, root, commits } = await open();
		const note = await createNote(folder);
		await commits(2);
		expect(notes.terminal.cwd).toBe('/');
		const listed = await notes.terminal.exec('ls notes');
		expect(listed.stdout.trim()).toBe(`${note.stem}.md`);
		const written = await notes.terminal.exec(
			`printf 'from the shell\\n' >> ${note.path} && pwd -P`,
		);
		expect(written.exitCode).toBe(0);
		expect(written.stdout.trim()).toBe(root);
		expect(await readFile(join(root, note.path), 'utf8')).toContain(
			'from the shell',
		);
		// The app sees the shell's write as a changed file.
		const stale = await folder.tables.notes.writeSource(
			note,
			`${note.source}mine\n`,
		);
		expect(stale.error?.name).toBe('Conflict');
		const log = await notes.terminal.exec(
			'git log --oneline && git rev-parse --is-inside-work-tree',
		);
		expect(log.stdout).toContain(`Add ${note.path}`);
		expect(log.stdout.trim().endsWith('true')).toBe(true);
		await notes.terminal.exec('cd notes');
		expect(notes.terminal.cwd).toBe('/notes');
		expect((await notes.terminal.exec('ls')).stdout.trim()).toBe(
			`${note.stem}.md`,
		);
		const failed = await notes.terminal.exec('exit 3');
		expect(failed.exitCode).toBe(3);
	});

	test('a note has per-file history, and an old version can be read', async () => {
		const { folder, notes, commits } = await open();
		const note = await createNote(folder);
		await commits(2);
		await folder.tables.notes.writeSource(
			note,
			note.source.replace('Hello', 'Second'),
		);
		await commits(3);
		const revisions = await notes.history!.log(note.path, 10);
		expect(revisions.map((revision) => revision.subject)).toEqual([
			`Update ${note.path}`,
			`Add ${note.path}`,
		]);
		expect(await notes.history!.show(revisions[1]!.oid, note.path)).toBe(
			note.source,
		);
		await expect(notes.history!.show('not-an-oid', note.path)).rejects.toThrow(
			'Not a commit id.',
		);
		await expect(
			notes.history!.show(revisions[0]!.oid, '../x'),
		).rejects.toThrow();
	});
});

describe('closing', () => {
	test('a native close requested before the page mounts waits for its listener', async () => {
		const { host, notes, shell } = await open();
		host.closeRequested();
		// Let the event arrive while no mounted page can answer it.
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(shell).toEqual([]);
		let asked = 0;
		notes.onCloseRequested(() => {
			asked += 1;
		});
		await until(() => asked === 1, 'the retained close request');
		expect(shell).toEqual([]);
		await notes.quit();
		expect(shell).toEqual([{ quit: true }]);
	});

	test('a close requested with the event stream disconnected reaches the reopened page', async () => {
		const { host, notes, send, shell } = await open();
		await notes.close();
		host.closeRequested();
		const reopened = await openBridgeNotesHost(
			createBridgeTransport({ origin: ORIGIN, token: TOKEN, fetch: send }),
		);
		cleanup.push(() => reopened.close());
		let asked = 0;
		reopened.onCloseRequested(() => {
			asked += 1;
		});
		await until(() => asked === 1, 'the close after reconnect');
		expect(shell).toEqual([]);
		await reopened.quit();
		expect(shell).toEqual([{ quit: true }]);
	});

	test('a held close waits for the page to explicitly agree to quit', async () => {
		const { host, notes, shell } = await open();
		let asked = 0;
		notes.onCloseRequested(() => {
			asked += 1;
		});
		// The first event on a new stream is the Git snapshot; wait for the stream.
		await new Promise((resolve) => setTimeout(resolve, 20));
		host.closeRequested();
		await until(() => asked === 1, 'the close request');
		expect(shell).toEqual([]);
		await notes.quit();
		expect(shell).toEqual([{ quit: true }]);
	});
});

describe('the page', () => {
	test('the built page is served with a policy that allows only its own inline scripts', async () => {
		const uiDist = await mkdtemp(join(tmpdir(), 'honeycrisp-ui-'));
		cleanup.push(() => rm(uiDist, { recursive: true, force: true }));
		await mkdir(join(uiDist, '_app'));
		await writeFile(
			join(uiDist, 'index.html'),
			'<html><head><script>boot()</script></head><body></body></html>',
		);
		await writeFile(join(uiDist, '_app', 'a.js'), 'export {}');
		const { send, root } = await open({ uiDist });
		const index = await send(new Request(`${ORIGIN}/some/route`));
		const html = await index.text();
		expect(html).toContain('boot()');
		expect(html).not.toContain(TOKEN);
		const policy = index.headers.get('content-security-policy')!;
		expect(policy).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
		expect(policy).toContain("connect-src 'self'");
		const asset = await send(new Request(`${ORIGIN}/_app/a.js`));
		expect(asset.headers.get('content-type')).toContain('text/javascript');
		expect((await send(new Request(`${ORIGIN}/_app/missing.js`))).status).toBe(
			404,
		);
		// The notes directory is never served as page assets.
		await writeFile(join(root, 'secret.txt'), 'secret');
		const escaped = await send(new Request(`${ORIGIN}/..%2f..%2fsecret.txt`));
		expect(await escaped.text()).not.toContain('secret');
	});

	test('events arrive as newline-delimited JSON starting with the Git snapshot', async () => {
		const { send, host } = await open();
		const response = await send(
			new Request(`${ORIGIN}/bridge/events`, {
				headers: { authorization: `Bearer ${TOKEN}` },
			}),
		);
		const reader = response.body!.getReader();
		const first = JSON.parse(
			new TextDecoder().decode((await reader.read()).value),
		) as BridgeEvent;
		expect(first.type).toBe('git');
		host.closeRequested();
		const second = JSON.parse(
			new TextDecoder().decode((await reader.read()).value),
		) as BridgeEvent;
		expect(second.type).toBe('closeRequested');
		await reader.cancel();
	});
});
