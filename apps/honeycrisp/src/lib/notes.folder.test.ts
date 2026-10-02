/**
 * Notes Over A Real Directory Tests
 *
 * Runs the notes state and its file sessions against a real temporary
 * directory with automatic history disabled. Explicit history checks use the
 * real `git`. The folder is the folder package's directory opener, with the same
 * handle the desktop page receives from the shell, so these cover what
 * Honeycrisp does with a folder, not how the page reaches one.
 *
 * Key behaviors:
 * - Reading a note never rewrites it; an edit keeps unknown frontmatter and comments
 * - A Git failure is history, never a save error
 * - A stale save is refused, and a dirty draft survives another writer
 * - A save acknowledges only the text it submitted
 * - A path owns one session across selection, rename, and deletion
 * - Rename and delete act on the capture the session holds, for notes and
 *   raw files alike
 * - A removed file's draft is saved back as the text it captured, and what
 *   another program writes afterwards stays that program's
 * - A change whose reply is lost is not confirmed, never "not saved". A save
 *   is sent again as it was and reconciles only on exactly its own text. A
 *   rename or delete stays as it was sent. A change with no open file is
 *   kept as a pending record that blocks a second one
 */
import './svelte-modules.test-support.js';
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
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
import type { InstantString } from '@epicenter/definition';
import { type FileCapture, FileError } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';
import { honeycrispDefinition, type NoteEntry } from './data.js';
import type { FileSession } from './file-session.svelte.js';
import { applyRichBody } from './note-source.js';
import { setUpFolder } from './platform/first-open.js';
import type { NotesFolder, NotesHost } from './platform/types.js';
import { draftsLine } from './status.js';

const { createNotes } = await import('./notes.svelte.ts');
const { watch } = await import('./effects.test-support.svelte.ts');

// Real git processes; generous under a loaded machine.
setDefaultTimeout(60_000);

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

/**
 * A new notes directory with automatic history disabled. Editor tests do not
 * wait for background commits; explicit history is exercised through the app.
 */
async function open() {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'honeycrisp-notes-')),
	);
	const opened = expectOk(
		await openFolder({
			root,
			definition: honeycrispDefinition,
			git: {
				author: { name: 'Honeycrisp', email: 'honeycrisp@localhost' },
				commitOnEdit: false,
			},
		}),
	);
	await setUpFolder(opened.files, Object.keys(honeycrispDefinition.tables));
	// The methods the notes UI uses, on plain objects a test can wrap.
	const folder: NotesFolder = {
		tables: {
			notes: { list: () => opened.tables.notes.list() },
			folders: { list: () => opened.tables.folders.list() },
		},
		files: {
			list: () => opened.files.list(),
			read: (...args) => opened.files.read(...args),
			create: (...args) => opened.files.create(...args),
			replace: (...args) => opened.files.replace(...args),
			remove: (...args) => opened.files.remove(...args),
			move: (...args) => opened.files.move(...args),
			mkdir: (...args) => opened.files.mkdir(...args),
			rmdir: (...args) => opened.files.rmdir(...args),
		},
		git: opened.git,
		// This folder hints at its own saves, not at other programs' writes.
		onFilesChanged: (listener) => opened.onFilesChanged(listener),
	};
	const ran: string[] = [];
	const host: NotesHost = {
		folder,
		terminal: {
			cwd: '/',
			description: '',
			exec: async (command) => {
				ran.push(command);
				return { stdout: '', stderr: '', exitCode: 0 };
			},
		},
		location: root,
		reveal: undefined,
		history: undefined,
		close: () => opened.close(),
	};
	cleanup.push(async () => {
		await opened.close();
		await rm(root, { recursive: true, force: true });
	});
	const git = (...args: string[]) =>
		spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
	/** A note already in the folder, as another session of the app would have left it. */
	const seedNote = async (title = 'First') =>
		expectOk(
			await opened.tables.notes.create({
				fields: {
					folderId: null,
					title,
					pinned: false,
					createdAt: '2026-10-01T00:00:00.000Z' as InstantString,
					updatedAt: '2026-10-01T00:00:00.000Z' as InstantString,
					deletedAt: null,
				},
				body: 'Hello\n',
			}),
		) as NoteEntry;
	/** The note files in the folder now. */
	const notePaths = async () =>
		expectOk(await opened.tables.notes.list()).entries.map(
			(entry) => entry.path,
		);
	return { host, folder, root, git, seedNote, notePaths, ran };
}

/** The notes state over a new directory. */
async function product() {
	const fixture = await open();
	const state = createNotes(fixture.host);
	cleanup.push(() => state.close());
	await state.refreshAll();
	return { ...fixture, state };
}

type State = Awaited<ReturnType<typeof product>>['state'];

/** A file opened in the notes state, with its session. */
async function opened(state: State, path: string): Promise<FileSession> {
	await state.refresh();
	await state.open(path);
	const session = state.sessionAt(path);
	if (session === undefined) throw new Error(`${path} did not open as text`);
	return session;
}

/** The drafts line as the header derives it. */
const draftsLineOf = (state: State) =>
	draftsLine({
		saving: state.saving,
		notSaved: state.notSaved,
		unconfirmed: state.unconfirmed,
		unsettled: state.unsettled,
	});

type ChangingVerb = 'create' | 'replace' | 'move' | 'remove' | 'mkdir';
type Reply = Promise<
	| { data: unknown; error: null }
	| { data: null; error: { name: string; message: string } }
>;

/**
 * Holds the folder's next call of `verb` before it is published. `asked`
 * resolves when it has been asked for; `release()` lets it go ahead.
 */
function holdNext(folder: NotesFolder, verb: ChangingVerb) {
	const real = folder.files[verb] as (...args: unknown[]) => Reply;
	const asked = Promise.withResolvers<void>();
	const held = Promise.withResolvers<void>();
	let done = false;
	(folder.files[verb] as unknown) = async (...args: unknown[]) => {
		if (!done) {
			done = true;
			asked.resolve();
			await held.promise;
		}
		return real(...args);
	};
	return { asked: asked.promise, release: () => held.resolve() };
}

/**
 * Loses the reply to the folder's next call of `verb`, as the desktop folder
 * reports a reply that never arrives. With `landed`, the real change runs
 * first. Without it nothing changes until the returned `land()` runs that
 * same call, with the arguments it was given.
 */
function loseNext(
	folder: NotesFolder,
	verb: ChangingVerb,
	{ landed }: { landed: boolean },
) {
	const real = folder.files[verb] as (...args: unknown[]) => Reply;
	const pending: { land?: () => Reply } = {};
	(folder.files[verb] as unknown) = async (...args: unknown[]) => {
		if (pending.land !== undefined) return real(...args);
		pending.land = () => real(...args);
		if (landed) await pending.land();
		const [first] = args;
		return FileError.Unconfirmed({
			path: typeof first === 'string' ? first : (first as FileCapture).path,
			operation: 'publishing to',
			cause: new Error('the webview lost its IPC connection'),
		});
	};
	return () => {
		if (pending.land === undefined) throw new Error(`No ${verb} was sent`);
		return pending.land();
	};
}

/** What another program leaves at a note's path: a whole, valid note. */
const OUTSIDE = [
	'---',
	'folderId: null',
	'title: Outside',
	'pinned: false',
	'createdAt: "2026-10-01T00:00:00.000Z"',
	'updatedAt: "2026-10-01T00:00:00.000Z"',
	'deletedAt: null',
	'---',
	'Written by another program',
	'',
].join('\n');

// ============================================================================
// Notes are files
// ============================================================================

describe('notes are files', () => {
	test('a new note opens its saved source and an explicit app commit records it', async () => {
		const { state, root, git } = await product();
		expect(await state.createNote()).toBeUndefined();
		const path = state.selectedPath as string;
		expect(path).toMatch(/^notes\/[0-9a-z]+\.md$/);
		const source = await readFile(join(root, path), 'utf8');
		expect(source).toMatch(
			/^---\nfolderId: null\ntitle: ""\npinned: false\ncreatedAt: .+\nupdatedAt: .+\ndeletedAt: null\n---\n$/,
		);
		const session = state.sessionAt(path);
		expect(session?.buffer).toBe(source);
		expect(session?.status).toBe('saved');
		expect(state.notes.map((entry) => entry.path)).toEqual([path]);
		expect(state.notes[0]?.issues).toBeUndefined();
		expect(state.pending).toEqual([]);
		expect((await state.commitNow()).status).toBe('committed');
		expect(git('show', `HEAD:${path}`)).toBe(source.trim());
	});

	test('listing, opening, and reading a note never rewrite it', async () => {
		const { state, folder, root } = await product();
		const path = join(root, 'notes', 'odd.md');
		const bytes = Buffer.from(
			'---\r\ntitle:   "Spaced"  # keep\r\nextra: [1, 2]\r\n---\r\n\r\n* a\r\n* b\r\n',
		);
		await writeFile(path, bytes);
		const before = await stat(path);
		await folder.tables.notes.list();
		await folder.files.read('notes/odd.md');
		const session = await opened(state, 'notes/odd.md');
		expect(session.buffer).toBe(bytes.toString('utf8'));
		expect(await session.settle()).toBe(true);
		expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
		expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
	});

	test('a body edit keeps unknown frontmatter, comments, and key order', async () => {
		const { state, root } = await product();
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
		const session = await opened(state, 'notes/keep.md');
		const next = expectOk(
			applyRichBody(
				session.buffer,
				'# New\n\n- [x] done',
				'2026-10-02T00:00:00.000Z' as InstantString,
			),
		);
		session.input(next);
		await session.save();
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
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		await state.refresh();
		expect(await state.createFolder('Work')).toBeUndefined();
		const [made] = state.folders;
		if (made?.stem === undefined) throw new Error('The folder is not listed');
		expect(await readFile(join(root, made.path), 'utf8')).toBe(
			'---\nname: Work\nicon: null\n---\n',
		);
		expect(
			await state.patchNote(note.path, { folderId: made.stem }),
		).toBeUndefined();
		const moved = state.notes.find((entry) => entry.path === note.path);
		expect(moved?.fields.folderId).toBe(made.stem);
		expect(state.notes).toHaveLength(1);
	});

	test('deleting a folder moves its notes out first and removes only its own file', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		await state.refresh();
		await state.createFolder('Work');
		const [made] = state.folders;
		if (made?.stem === undefined) throw new Error('The folder is not listed');
		await state.patchNote(note.path, { folderId: made.stem });
		expect(await state.deleteFolder(made)).toBeUndefined();
		expect(state.folders).toEqual([]);
		expect(state.notes[0]?.fields.folderId).toBeNull();
		await expect(stat(join(root, made.path))).rejects.toThrow();
		expect(await readFile(join(root, note.path), 'utf8')).toContain(
			'folderId: null',
		);
	});
});

// ============================================================================
// Git failures are history
// ============================================================================

test('a Git failure leaves the file saved and is reported as history, not as a save error', async () => {
	const { state, root, git, seedNote } = await product();
	const note = await seedNote();
	const session = await opened(state, note.path);
	// The save finishes before an explicit app commit meets the branch lock.
	await writeFile(join(root, '.git', 'refs', 'heads', 'main.lock'), '');
	session.input(note.source.replace('Hello', 'Locked out'));
	await session.save();
	expect(session.status).toBe('saved');
	expect((await state.commitNow()).status).toBe('failed');
	expect(state.git.lastCommit?.status).toBe('failed');
	expect(draftsLineOf(state).label).toBe('No unsaved drafts');
	expect(await readFile(join(root, note.path), 'utf8')).toContain('Locked out');
	expect(git('rev-parse', '--verify', '--quiet', 'HEAD')).toBe('');
	expect(
		git(
			'--no-optional-locks',
			'status',
			'--porcelain',
			'--untracked-files=all',
		),
	).toContain(note.path);
	// History catches up with the next commit; the save was never undone.
	await rm(join(root, '.git', 'refs', 'heads', 'main.lock'));
	expect((await state.commitNow()).status).toBe('committed');
	expect(git('--no-optional-locks', 'status', '--porcelain')).toBe('');
});

// ============================================================================
// Other writers
// ============================================================================

describe('other writers', () => {
	test('a save based on a file another program changed is refused', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await opened(state, note.path);
		await writeFile(
			join(root, note.path),
			note.source.replace('Hello', 'Changed outside'),
		);
		session.input(note.source.replace('Hello', 'Mine'));
		await session.save();
		expect(session.status).toBe('conflict');
		expect(session.saved.source).toBe(note.source);
		expect(await readFile(join(root, note.path), 'utf8')).toContain(
			'Changed outside',
		);
	});

	test('a dirty draft survives an external edit and can save over the reviewed version', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await opened(state, note.path);
		session.input(note.source.replace('Hello', 'Mine'));
		await writeFile(
			join(root, note.path),
			note.source.replace('Hello', 'Theirs'),
		);
		await session.save();
		expect(session.status).toBe('conflict');
		expect(session.buffer).toContain('Mine');
		const reviewed = session.external;
		expect(reviewed).toMatchObject({ kind: 'changed' });
		expect(await readFile(join(root, note.path), 'utf8')).toContain('Theirs');
		if (reviewed === undefined) throw new Error('No conflict was recorded');
		expect(await session.saveMine(reviewed)).toBe(true);
		expect(session.status).toBe('saved');
		expect(await readFile(join(root, note.path), 'utf8')).toContain('Mine');
	});

	test('a review of one version cannot save over a newer one', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await opened(state, note.path);
		session.input(note.source.replace('Hello', 'Mine'));
		await writeFile(join(root, note.path), note.source.replace('Hello', 'B'));
		await state.refresh();
		const reviewed = session.external;
		if (reviewed === undefined) throw new Error('No conflict was recorded');
		const newer = note.source.replace('Hello', 'C');
		await writeFile(join(root, note.path), newer);
		// Unseen: the write's own condition refuses it.
		expect(await session.saveMine(reviewed)).toBe(true);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(newer);
		expect(session.saved.source).toBe(note.source);
		expect(session.external).toMatchObject({ current: { source: newer } });
		// Seen: the stale review is not accepted at all.
		expect(await session.saveMine(reviewed)).toBe(false);
		expect(session.takeTheirs(reviewed)).toBe(false);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(newer);
		expect(session.buffer).toContain('Mine');
	});

	test('a file deleted outside leaves the draft, which is written back exclusively', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const session = await opened(state, note.path);
		await rm(join(root, note.path));
		const mine = note.source.replace('Hello', 'Mine');
		session.input(mine);
		await session.save();
		expect(session.external).toEqual({ kind: 'removed' });
		expect((await folder.files.read(note.path)).error?.name).toBe('NotFound');
		expect(await state.recoverDraft(note.path)).toBeUndefined();
		expect(await readFile(join(root, note.path), 'utf8')).toBe(mine);
		expect(session.status).toBe('saved');
	});

	test('a malformed file stays listed with its issue and its source, and is repaired as text', async () => {
		const { state, folder, root } = await product();
		await writeFile(
			join(root, 'notes', 'bad.md'),
			'---\ntitle: *missing\n---\nbody\n',
		);
		await writeFile(
			join(root, 'notes', 'binary.md'),
			new Uint8Array([0xff, 0xfe, 0x00]),
		);
		const listed = expectOk(await folder.tables.notes.list());
		const bad = listed.entries.find((entry) => entry.path === 'notes/bad.md');
		if (bad === undefined) throw new Error('The malformed note is not listed');
		expect(bad.issues?.[0]?.kind).toBe('frontmatter');
		expect(bad.source).toContain('*missing');
		expect(listed.unreadable.map((item) => item.path)).toEqual([
			'notes/binary.md',
		]);
		const session = await opened(state, 'notes/bad.md');
		session.input('---\ntitle: Fixed\n---\nbody\n');
		await session.save();
		await state.refresh();
		const repaired = state.notes.find((entry) => entry.path === 'notes/bad.md');
		expect(repaired?.fields.title).toBe('Fixed');
	});
});

// ============================================================================
// Slow saves
// ============================================================================

describe('slow saves', () => {
	test('a save that waited is checked against the file as it is then', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const session = await opened(state, note.path);
		const write = holdNext(folder, 'replace');
		session.input(note.source.replace('Hello', 'Held'));
		const saving = session.save();
		await write.asked;
		expect(session.status).toBe('saving');
		expect(await readFile(join(root, note.path), 'utf8')).toContain('Hello');
		await writeFile(
			join(root, note.path),
			note.source.replace('Hello', 'Outside'),
		);
		write.release();
		await saving;
		expect(session.status).toBe('conflict');
		expect(session.buffer).toContain('Held');
		expect(await readFile(join(root, note.path), 'utf8')).toContain('Outside');
	});

	test('typing during a save stays a draft: the save acknowledges only what it submitted', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const session = await opened(state, note.path);
		const write = holdNext(folder, 'replace');
		const a = note.source.replace('Hello', 'A');
		session.input(a);
		const saving = session.save();
		await write.asked;
		expect(session.status).toBe('saving');
		session.input(note.source.replace('Hello', 'A and B'));
		write.release();
		await saving;
		expect(session.saved.source).toBe(a);
		expect(session.buffer).toContain('A and B');
		expect(session.dirty).toBe(true);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(a);
	});
});

// ============================================================================
// Kept sessions
// ============================================================================

/**
 * A path owns one session across note and file views, rename, and external
 * classification changes.
 */
describe('kept sessions', () => {
	test('a note and a raw file keep the same sessions when selection changes', async () => {
		const { state, folder, seedNote } = await product();
		const note = await seedNote();
		expectOk(await folder.files.create('scratch.txt', 'raw\n'));
		await state.refresh();
		await state.open(note.path);
		const noteSession = state.sessionAt(note.path);
		await state.open('scratch.txt');
		const rawSession = state.sessionAt('scratch.txt');
		await state.open(note.path);
		expect(state.selection?.kind).toBe('note');
		expect(state.sessionAt(note.path)).toBe(noteSession);
		await state.open('scratch.txt');
		expect(state.selection?.kind).toBe('file');
		expect(state.sessionAt('scratch.txt')).toBe(rawSession);
		expect(state.unsettled).toBe(0);
	});

	test('renaming an edited raw file keeps its session and writes only to the new path', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('scratch.txt', 'raw\n'));
		const session = await opened(state, 'scratch.txt');
		session.input('saved before rename\n');
		expect(await state.rename('scratch.txt', 'renamed.txt')).toBeUndefined();
		expect(state.sessionAt('scratch.txt')).toBeUndefined();
		expect(state.sessionAt('renamed.txt')).toBe(session);
		expect(state.selectedPath).toBe('renamed.txt');
		session.input('saved after rename\n');
		await session.save();
		expect(await readFile(join(root, 'renamed.txt'), 'utf8')).toBe(
			'saved after rename\n',
		);
		await expect(stat(join(root, 'scratch.txt'))).rejects.toThrow();
	});

	test('renaming an edited note keeps its session, its text, and its place in the list', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await opened(state, note.path);
		const edited = note.source.replace('Hello', 'Edited before rename');
		session.input(edited);
		expect(await state.rename(note.path, 'renamed.md')).toBeUndefined();
		expect(state.sessionAt('notes/renamed.md')).toBe(session);
		expect(state.selection?.kind).toBe('note');
		expect(state.notes.map((entry) => entry.path)).toEqual([
			'notes/renamed.md',
		]);
		expect(await readFile(join(root, 'notes/renamed.md'), 'utf8')).toBe(edited);
		await expect(stat(join(root, note.path))).rejects.toThrow();
		expect(await state.rename('notes/renamed.md', 'renamed.txt')).toBe(
			'A note file keeps its .md extension.',
		);
	});

	test('deleting an edited raw file captures its saved version and forgets only that session', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('scratch.txt', 'raw\n'));
		const session = await opened(state, 'scratch.txt');
		session.input('saved before deleting\n');
		const deletion = expectOk(await state.deletionFor('scratch.txt'));
		expect(deletion).toEqual({
			kind: 'file',
			file: { path: 'scratch.txt', sha256: session.saved.sha256 },
			title: undefined,
		});
		expect(await readFile(join(root, 'scratch.txt'), 'utf8')).toBe(
			'saved before deleting\n',
		);
		expect(await state.remove(deletion)).toBeUndefined();
		expect(state.sessionAt('scratch.txt')).toBeUndefined();
		expect(state.selectedPath).toBeUndefined();
		await expect(stat(join(root, 'scratch.txt'))).rejects.toThrow();
	});

	test('a raw file changed after deletion was confirmed is kept with its session', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('scratch.txt', 'raw\n'));
		const session = await opened(state, 'scratch.txt');
		const deletion = expectOk(await state.deletionFor('scratch.txt'));
		await writeFile(join(root, 'scratch.txt'), 'outside change\n');
		expect(await state.remove(deletion)).toContain('The file changed');
		expect(state.sessionAt('scratch.txt')).toBe(session);
		expect(session.buffer).toBe('outside change\n');
		expect(await readFile(join(root, 'scratch.txt'), 'utf8')).toBe(
			'outside change\n',
		);
	});

	test('a note changed after its deletion was confirmed is kept, whether or not it was open', async () => {
		const { state, root, seedNote } = await product();
		const shown = await seedNote('Shown');
		const listed = await seedNote('Listed');
		const session = await opened(state, shown.path);
		const outside = (note: NoteEntry) =>
			note.source.replace('Hello', 'Written by another program');
		for (const note of [shown, listed]) {
			const deletion = expectOk(await state.deletionFor(note.path));
			// The dialog names the note the person was looking at.
			expect(deletion).toMatchObject({
				kind: 'file',
				file: { path: note.path, sha256: note.sha256 },
				title: note.fields.title,
			});
			await writeFile(join(root, note.path), outside(note));
			expect(await state.remove(deletion)).toContain('The file changed');
			expect(await readFile(join(root, note.path), 'utf8')).toBe(outside(note));
		}
		expect(state.sessionAt(shown.path)).toBe(session);
		expect(session.buffer).toBe(outside(shown));
		expect(state.pending).toEqual([]);
	});

	test('a raw file renamed into a note keeps its session and is listed as a note', async () => {
		const { state, folder, root } = await product();
		const source =
			'---\ntitle: Before\n# keep this comment\nunknown: "keep"\n---\nBody\n';
		expectOk(await folder.files.create('notes/raw.txt', source));
		const session = await opened(state, 'notes/raw.txt');
		expect(await state.rename('notes/raw.txt', 'raw.md')).toBeUndefined();
		expect(state.sessionAt('notes/raw.md')).toBe(session);
		expect(state.selection?.kind).toBe('note');
		expect(state.isNote('notes/raw.md')).toBe(true);
		expect(
			await state.patchNote('notes/raw.md', { title: 'After' }),
		).toBeUndefined();
		const saved = await readFile(join(root, 'notes/raw.md'), 'utf8');
		expect(saved).toContain('title: After');
		expect(saved).toContain('# keep this comment\nunknown: "keep"');
	});

	test('a dirty note survives malformed external source and refuses rename until resolved', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await opened(state, note.path);
		session.input(`${note.source}my unsaved text\n`);
		await writeFile(
			join(root, note.path),
			'---\ntitle: [broken\n---\noutside\n',
		);
		await state.refresh();
		expect(state.sessionAt(note.path)).toBe(session);
		expect(session.buffer).toContain('my unsaved text');
		const reviewed = session.external;
		expect(reviewed?.kind).toBe('changed');
		expect(await state.rename(note.path, 'renamed.md')).toBe(
			'Save or discard the open edits first.',
		);
		expect(await readFile(join(root, note.path), 'utf8')).toContain('[broken');
		if (reviewed === undefined) throw new Error('No conflict was recorded');
		expect(session.takeTheirs(reviewed)).toBe(true);
		expect(session.buffer).toContain('[broken');
	});

	test('metadata changes share the open session, with explicit deferred and immediate saves', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await opened(state, note.path);
		expect(
			await state.patchNote(
				note.path,
				{ title: 'Typed title' },
				{ save: 'later' },
			),
		).toBeUndefined();
		expect(session.buffer).toContain('title: Typed title');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(note.source);
		expect(await state.patchNote(note.path, { pinned: true })).toBeUndefined();
		const saved = await readFile(join(root, note.path), 'utf8');
		expect(saved).toContain('title: Typed title');
		expect(saved).toContain('pinned: true');
		expect(state.sessionAt(note.path)).toBe(session);
	});

	test('an unopened metadata action replaces the listed file and keeps no session', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		await state.refresh();
		expect(await state.patchNote(note.path, { pinned: true })).toBeUndefined();
		expect(state.sessionAt(note.path)).toBeUndefined();
		expect(state.selectedPath).toBeUndefined();
		expect(state.pending).toEqual([]);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(
			note.source.replace('pinned: false', 'pinned: true'),
		);
	});

	test('an unopened metadata action on a note another program changed is refused, and is not pending', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		await state.refresh();
		const outside = note.source.replace('Hello', 'Written by another program');
		await writeFile(join(root, note.path), outside);
		expect(await state.patchNote(note.path, { pinned: true })).toContain(
			'The file changed',
		);
		expect(state.pending).toEqual([]);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(outside);
	});

	test('a listing captured before a save cannot roll the saved session back after the save', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const session = await opened(state, note.path);
		const list = folder.tables.notes.list;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let held = false;
		folder.tables.notes.list = async () => {
			const result = await list();
			if (!held) {
				held = true;
				started.resolve();
				await release.promise;
			}
			return result;
		};
		const observed: string[] = [];
		const stop = watch(() => {
			observed.push(session.buffer);
		});
		const refreshing = state.refresh();
		await started.promise;
		session.input(`${note.source}saved while listing waits\n`);
		await session.save();
		const saved = session.saved;
		release.resolve();
		await refreshing;
		await new Promise((resolve) => setTimeout(resolve, 0));
		stop();
		expect(session.saved.sha256).toEqual(saved.sha256);
		expect(session.buffer).toBe(saved.source);
		expect(session.external).toBeUndefined();
		// A second old value means the screen actually rolled back, even if the
		// save's queued refresh eventually put the new value back.
		expect(observed.filter((source) => source === note.source)).toHaveLength(1);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(saved.source);
	});

	test('renaming a raw file refuses a destination with a kept removed-file draft', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('a.txt', 'A\n'));
		expectOk(await folder.files.create('b.txt', 'B\n'));
		const a = await opened(state, 'a.txt');
		const b = await opened(state, 'b.txt');
		b.input('Retained B\n');
		await rm(join(root, 'b.txt'));
		await state.refresh();
		expect(b.external?.kind).toBe('removed');
		expect(await state.rename('a.txt', 'b.txt')).toContain('draft');
		expect(state.sessionAt('a.txt')).toBe(a);
		expect(state.sessionAt('b.txt')).toBe(b);
		expect(b.buffer).toBe('Retained B\n');
		expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('A\n');
		await expect(stat(join(root, 'b.txt'))).rejects.toThrow();
		state.discardDraft('b.txt');
		expect(state.sessionAt('b.txt')).toBeUndefined();
	});

	test('a removed raw file is saved back at its own path, and a path that holds other text is a conflict', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('b.txt', 'B\n'));
		const b = await opened(state, 'b.txt');
		b.input('Retained B\n');
		await rm(join(root, 'b.txt'));
		await state.refresh();
		// Another program puts a different file there before the draft is saved.
		await writeFile(join(root, 'b.txt'), 'Other\n');
		expect(await state.recoverDraft('b.txt')).toContain('The file changed');
		expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('Other\n');
		expect(b.buffer).toBe('Retained B\n');
		const reviewed = b.external;
		expect(reviewed).toMatchObject({ current: { source: 'Other\n' } });
		if (reviewed === undefined) throw new Error('No conflict was recorded');
		expect(await b.saveMine(reviewed)).toBe(true);
		expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('Retained B\n');
		expect((await folder.files.list()).data?.files.map((f) => f.path)).toEqual([
			'b.txt',
			'kv.json',
		]);
	});

	test('renaming a note also refuses a destination with a kept removed-note draft', async () => {
		const { state, root, seedNote } = await product();
		const a = await seedNote('A');
		const b = await seedNote('B');
		const aSession = await opened(state, a.path);
		const bSession = await opened(state, b.path);
		bSession.input(`${b.source}Retained B\n`);
		await rm(join(root, b.path));
		await state.refresh();
		expect(bSession.external?.kind).toBe('removed');
		expect(await state.rename(a.path, `${b.stem}.md`)).toContain('draft');
		expect(state.sessionAt(a.path)).toBe(aSession);
		expect(state.sessionAt(b.path)).toBe(bSession);
		expect(bSession.buffer).toContain('Retained B');
		expect(await readFile(join(root, a.path), 'utf8')).toBe(a.source);
		state.discardDraft(b.path);
	});

	test('a refresh awaiting a raw read cannot forget a session renamed while it waits', async () => {
		const { state, folder } = await product();
		expectOk(await folder.files.create('scratch.txt', 'raw\n'));
		const session = await opened(state, 'scratch.txt');
		const read = folder.files.read;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let held = false;
		folder.files.read = async (path) => {
			const result = await read(path);
			if (path === 'scratch.txt' && !held) {
				held = true;
				started.resolve();
				await release.promise;
			}
			return result;
		};
		const refreshing = state.refresh();
		await started.promise;
		const renaming = state.rename('scratch.txt', 'renamed.txt');
		await until(
			() => state.sessionAt('renamed.txt') === session,
			'the renamed session',
		);
		release.resolve();
		await refreshing;
		expect(await renaming).toBeUndefined();
		expect(state.sessionAt('renamed.txt')).toBe(session);
		expect(session.external).toBeUndefined();
		expect(session.path).toBe('renamed.txt');
	});
});

// ============================================================================
// The input fence
// ============================================================================

describe('while input is fenced', () => {
	test('nothing is typed, created, renamed, or deleted, and it all works again on release', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await opened(state, note.path);
		session.input(`${note.source}typed before the fence\n`);
		const release = state.fenceInput();
		expect(state.fenced).toBe(true);
		expect(session.input(`${note.source}typed late\n`)).toBe(false);
		expect(await state.patchNote(note.path, { pinned: true })).toContain(
			'closing',
		);
		expect(await state.createNote()).toContain('closing');
		expect(await state.createFolder('Work')).toContain('closing');
		expect(await state.createFile('', 'new.txt')).toContain('closing');
		expect(await state.createDirectory('', 'new')).toContain('closing');
		expect(await state.rename(note.path, 'renamed.md')).toContain('closing');
		expect((await state.deletionFor(note.path)).error).toContain('closing');
		expect(
			await state.remove({
				kind: 'file',
				file: session.saved,
				title: undefined,
			}),
		).toContain('closing');
		expect((await session.move('notes/renamed.md')).kind).toBe('unsettled');
		// What was already typed is still saved for the close.
		expect(await state.settleAll()).toBe(0);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(
			`${note.source}typed before the fence\n`,
		);
		expect(state.notes).toHaveLength(1);
		release();
		expect(state.fenced).toBe(false);
		expect(session.input(`${note.source}typed after\n`)).toBe(true);
		expect(await state.patchNote(note.path, { pinned: true })).toBeUndefined();
	});

	test('no terminal command starts and no commit is asked for, and the typed command is kept', async () => {
		const { state, ran } = await product();
		const release = state.fenceInput();
		state.terminal.command = 'rm -rf notes';
		await state.terminal.run();
		expect(ran).toEqual([]);
		expect(state.terminal.command).toBe('rm -rf notes');
		expect(state.terminal.runs).toEqual([]);
		expect((await state.commitNow()).status).toBe('blocked');
		release();
		state.terminal.command = 'echo ok';
		await state.terminal.run();
		expect(ran).toEqual(['echo ok']);
	});
});

// ============================================================================
// Rename and unseen text
// ============================================================================

describe('rename and text the session has not seen', () => {
	test("renaming a note another program just rewrote is refused, and that program's text is kept", async () => {
		const { state, root, seedNote, notePaths } = await product();
		const note = await seedNote();
		const session = await opened(state, note.path);
		expect(session.dirty).toBe(false);
		// No refresh follows: the open session still holds the note as created.
		await writeFile(join(root, note.path), OUTSIDE);
		expect(await state.rename(note.path, 'renamed.md')).toContain(
			'The file changed',
		);
		await session.settle();
		expect(await notePaths()).toEqual([note.path]);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(OUTSIDE);
		expect(session.buffer).toBe(OUTSIDE);
		expect(state.sessionAt(note.path)).toBe(session);
	});

	test('renaming a raw file another program just rewrote is refused the same way', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('scratch.txt', 'raw\n'));
		const session = await opened(state, 'scratch.txt');
		await writeFile(join(root, 'scratch.txt'), 'outside change\n');
		expect(await state.rename('scratch.txt', 'renamed.txt')).toContain(
			'The file changed',
		);
		await session.settle();
		expect(state.sessionAt('scratch.txt')).toBe(session);
		expect(session.buffer).toBe('outside change\n');
		expect(await readFile(join(root, 'scratch.txt'), 'utf8')).toBe(
			'outside change\n',
		);
		await expect(stat(join(root, 'renamed.txt'))).rejects.toThrow();
	});

	test('renaming onto a name that exists is refused and replaces nothing', async () => {
		const { state, root, seedNote } = await product();
		const a = await seedNote('A');
		const b = await seedNote('B');
		const session = await opened(state, a.path);
		expect(await state.rename(a.path, `${b.stem}.md`)).toBe(
			`"${b.stem}.md" already exists here.`,
		);
		expect(state.sessionAt(a.path)).toBe(session);
		expect(await readFile(join(root, a.path), 'utf8')).toBe(a.source);
		expect(await readFile(join(root, b.path), 'utf8')).toBe(b.source);
	});
});

// ============================================================================
// A removed note's draft
// ============================================================================

/**
 * A dirty note draft whose file was deleted outside, ready to be written
 * back. `afterCreate` runs once that exclusive creation has landed and before
 * its reply reaches the session; `afterRefusal` runs when a creation is
 * refused.
 */
async function removedNoteDraft({
	afterCreate = () => {},
	afterRefusal = () => {},
}: {
	afterCreate?: (at: {
		session: FileSession;
		file: string;
	}) => void | Promise<void>;
	afterRefusal?: (at: { session: FileSession }) => void;
} = {}) {
	const fixture = await product();
	const { state, folder, root, seedNote } = fixture;
	const note = await seedNote();
	const session = await opened(state, note.path);
	const file = join(root, note.path);
	await rm(file);
	const admitted = `${note.source}Typed before the file was deleted\n`;
	session.input(admitted);
	// The save is refused, and the read that follows finds the file gone.
	await session.save();
	expect(session.external).toEqual({ kind: 'removed' });
	const create = folder.files.create;
	/** Every creation the folder accepted, as it was asked for. */
	const created: { path: string; content: string | Uint8Array }[] = [];
	folder.files.create = async (path, content) => {
		const result = await create(path, content);
		if (result.error?.name === 'Exists') afterRefusal({ session });
		if (result.error === null) {
			created.push({ path, content });
			if (created.length === 1) await afterCreate({ session, file });
		}
		return result;
	};
	return { ...fixture, session, path: note.path, file, admitted, created };
}

describe("a removed note's draft", () => {
	test('writing it back never leaves the session agreeing with text another program put there next', async () => {
		const { state, session, path, file, admitted, created } =
			await removedNoteDraft({
				afterCreate: ({ file }) => writeFile(file, OUTSIDE),
			});
		// Every state the screen could have shown.
		const shown: { saved: string; buffer: string; conflict: boolean }[] = [];
		const stop = watch(() => {
			shown.push({
				saved: session.saved.source,
				buffer: session.buffer,
				conflict: session.external !== undefined,
			});
		});
		expect(await state.recoverDraft(path)).toBeUndefined();
		await session.settle();
		await new Promise((resolve) => setTimeout(resolve, 0));
		stop();
		expect(created).toEqual([{ path, content: admitted }]);
		// The other program's text was never taken as this draft's saved base
		// while the draft still held different text.
		expect(
			shown.filter(
				(state) =>
					state.saved === OUTSIDE &&
					state.buffer !== OUTSIDE &&
					!state.conflict,
			),
		).toEqual([]);
		// It is a separate observation: the clean session shows it, and it is on disk.
		expect(session.buffer).toBe(OUTSIDE);
		expect(await readFile(file, 'utf8')).toBe(OUTSIDE);
	});

	test('typing while it is written back stays a draft and meets the other file as a conflict', async () => {
		const typed = 'Typed while the note was being written back\n';
		const { state, session, path, file, admitted } = await removedNoteDraft({
			async afterCreate({ session, file }) {
				session.input(`${session.buffer}${typed}`);
				await writeFile(file, OUTSIDE);
			},
		});
		expect(await state.recoverDraft(path)).toBeUndefined();
		await state.refresh();
		expect(session.buffer).toBe(`${admitted}${typed}`);
		expect(session.external?.kind).toBe('changed');
		expect(session.external).toMatchObject({ current: { source: OUTSIDE } });
		expect(await session.settle()).toBe(false);
		expect(session.buffer).toBe(`${admitted}${typed}`);
		expect(await readFile(file, 'utf8')).toBe(OUTSIDE);
	});

	test('typing while it is written back stays a draft when nothing else writes', async () => {
		const typed = 'Typed while the note was being written back\n';
		const { state, session, path, file, admitted, created } =
			await removedNoteDraft({
				afterCreate: ({ session }) => {
					session.input(`${session.buffer}${typed}`);
				},
			});
		expect(await state.recoverDraft(path)).toBeUndefined();
		// What was created is the text captured when it was asked for.
		expect(created).toEqual([{ path, content: admitted }]);
		expect(session.buffer).toBe(`${admitted}${typed}`);
		expect(await session.settle()).toBe(true);
		expect(await readFile(file, 'utf8')).toBe(`${admitted}${typed}`);
	});

	test('a draft refused at its own path is written to a new one as the text first captured', async () => {
		const typed = 'Typed while the first path refused\n';
		const { state, session, path, file, admitted, created, notePaths } =
			await removedNoteDraft({
				afterRefusal: ({ session }) => {
					session.input(`${session.buffer}${typed}`);
				},
			});
		// Another program put a file back before the draft was written back.
		await writeFile(file, OUTSIDE);
		expect(await state.recoverDraft(path)).toBeUndefined();
		const [written] = created;
		if (written === undefined) throw new Error('Nothing was created');
		expect(created).toHaveLength(1);
		expect(written.path).not.toBe(path);
		expect(written.content).toBe(admitted);
		// The one session moved with its text, and the selection with it.
		expect(state.sessionAt(written.path)).toBe(session);
		expect(state.sessionAt(path)).toBeUndefined();
		expect(state.selectedPath).toBe(written.path);
		expect(await readFile(file, 'utf8')).toBe(OUTSIDE);
		expect(await session.settle()).toBe(true);
		expect(await readFile(join(file, '..', '..', written.path), 'utf8')).toBe(
			`${admitted}${typed}`,
		);
		expect((await notePaths()).sort()).toEqual([path, written.path].sort());
	});

	test('a write back that landed with its reply lost is found in the folder, and pressing again makes no second note', async () => {
		const { state, folder, session, path, file, admitted, notePaths } =
			await removedNoteDraft();
		loseNext(folder, 'create', { landed: true });
		await state.recoverDraft(path);
		await state.refresh();
		expect(await readFile(file, 'utf8')).toBe(admitted);
		// Exactly the attempted text is at its path, so that is the saved text.
		expect(session.attempt).toBeUndefined();
		expect(session.saved.source).toBe(admitted);
		expect(session.status).toBe('saved');
		expect(state.notSaved).toBe(0);
		expect(await state.recoverDraft(path)).toBeUndefined();
		expect(await notePaths()).toEqual([path]);
	});

	test('a write back not yet in the folder stays unconfirmed, and pressing again sends the same text to the same path', async () => {
		const { state, folder, session, path, file, admitted, notePaths } =
			await removedNoteDraft();
		const land = loseNext(folder, 'create', { landed: false });
		expect(await state.recoverDraft(path)).toContain('not confirmed');
		// The path is still empty. That cannot say the creation will not happen.
		await expect(stat(file)).rejects.toThrow();
		expect(session.attempt).toMatchObject({
			path,
			source: admitted,
			kind: 'create',
			state: 'unconfirmed',
		});
		expect(state.notSaved).toBe(0);
		expect(draftsLineOf(state).label).toBe('1 change not confirmed');
		const b = `${admitted}B\n`;
		session.input(b);
		expect(await state.recoverDraft(path)).toBeUndefined();
		expect(session.saved.source).toBe(admitted);
		expect(session.buffer).toBe(b);
		// The first creation arrives late and is refused by its own condition.
		expect((await land()).error?.name).toBe('Exists');
		expect(await session.settle()).toBe(true);
		expect(await readFile(file, 'utf8')).toBe(b);
		expect(await notePaths()).toEqual([path]);
	});

	test('a first creation that lands between two presses does not leave the draft in two notes', async () => {
		const { state, folder, session, path, file, admitted, notePaths } =
			await removedNoteDraft();
		const land = loseNext(folder, 'create', { landed: false });
		await state.recoverDraft(path);
		await expect(stat(file)).rejects.toThrow();
		expectOk(await land());
		expect(await readFile(file, 'utf8')).toBe(admitted);
		const b = `${admitted}B\n`;
		session.input(b);
		// The occupant is this draft's own earlier text: no second note is made.
		expect(await state.recoverDraft(path)).toBeUndefined();
		expect(session.path).toBe(path);
		expect(session.attempt).toBeUndefined();
		expect(session.saved.source).toBe(admitted);
		expect(session.buffer).toBe(b);
		expect(await notePaths()).toEqual([path]);
		expect(await session.settle()).toBe(true);
		expect(await readFile(file, 'utf8')).toBe(b);
		expect(await notePaths()).toEqual([path]);
	});

	test('other text at the path while a write back is unconfirmed is shown beside it, and no second note is made', async () => {
		const { state, folder, session, path, file, admitted, notePaths } =
			await removedNoteDraft();
		const land = loseNext(folder, 'create', { landed: false });
		await state.recoverDraft(path);
		await writeFile(file, OUTSIDE);
		expect(await state.recoverDraft(path)).toContain('not confirmed');
		expect(session.external).toMatchObject({ current: { source: OUTSIDE } });
		expect(session.attempt).toMatchObject({
			path,
			source: admitted,
			kind: 'create',
			state: 'unconfirmed',
		});
		expect(session.buffer).toBe(admitted);
		expect(await readFile(file, 'utf8')).toBe(OUTSIDE);
		expect(await notePaths()).toEqual([path]);
		// The first creation cannot land while the path is not empty.
		expect((await land()).error?.name).toBe('Exists');
		expect(await readFile(file, 'utf8')).toBe(OUTSIDE);
	});
});

// ============================================================================
// A save whose reply is lost
// ============================================================================

describe('a save whose reply is lost', () => {
	/**
	 * An open note whose save of `a` gets no reply. With `landed`, the file was
	 * written first. Without it the file is unchanged until `land()` runs that
	 * same conditional replace.
	 */
	async function unconfirmedSave({ landed }: { landed: boolean }) {
		const fixture = await product();
		const { state, folder, root, seedNote } = fixture;
		const note = await seedNote();
		const session = await opened(state, note.path);
		const land = loseNext(folder, 'replace', { landed });
		const a = `${note.source}A\n`;
		session.input(a);
		await session.save();
		return { ...fixture, session, note, file: join(root, note.path), a, land };
	}

	test('it is reported as not confirmed, never as not saved, and keeps exactly what it sent', async () => {
		const { state, session, note, file, a } = await unconfirmedSave({
			landed: false,
		});
		expect(await readFile(file, 'utf8')).toBe(note.source);
		expect(session.status).toBe('unconfirmed');
		expect(session.attempt).toMatchObject({
			path: note.path,
			source: a,
			kind: 'replace',
			expectedSha256: note.sha256,
			state: 'unconfirmed',
		});
		expect(session.failure).toBeUndefined();
		expect(state.notSaved).toBe(0);
		expect(draftsLineOf(state)).toEqual({
			label: '1 change not confirmed',
			detail:
				'Each may or may not have happened. Open the note, or see Not confirmed below.',
			tone: 'warning',
		});
		// Closing is held back: nothing claims the text is safe.
		expect(await state.settleAll()).toBe(1);
	});

	test('one that landed is found in the folder: saved, with no conflict and no "not saved"', async () => {
		const { state, session, file, a } = await unconfirmedSave({ landed: true });
		await state.refresh();
		expect(await readFile(file, 'utf8')).toBe(a);
		expect(session.attempt).toBeUndefined();
		expect(session.saved.source).toBe(a);
		expect(session.external).toBeUndefined();
		expect(session.status).toBe('saved');
		expect(state.notSaved).toBe(0);
		expect(draftsLineOf(state).label).toBe('No unsaved drafts');
	});

	test('a read that still finds the old file does not mean it failed: it lands later, and only then is it saved', async () => {
		const { state, session, note, file, a, land } = await unconfirmedSave({
			landed: false,
		});
		// Everything the page can read says the old file is still there.
		await state.refresh();
		expect(await readFile(file, 'utf8')).toBe(note.source);
		expect(session.status).toBe('unconfirmed');
		expect(session.saved.source).toBe(note.source);
		expect(state.notSaved).toBe(0);
		// The same save is published afterwards, with no further action.
		expectOk(await land());
		await state.refresh();
		expect(await readFile(file, 'utf8')).toBe(a);
		expect(session.status).toBe('saved');
		expect(session.saved.source).toBe(a);
		expect(state.unconfirmed).toBe(0);
	});

	test('newer typing does not replace it: sending again before it lands sends the same text, and the late save is refused', async () => {
		const { session, file, a, land } = await unconfirmedSave({ landed: false });
		const b = `${a}B\n`;
		session.input(b);
		// Saving is paused while the outcome is unknown.
		expect(await session.settle()).toBe(false);
		expect(await readFile(file, 'utf8')).not.toContain('A\n');
		await session.retry();
		expect(await readFile(file, 'utf8')).toBe(a);
		expect(session.saved.source).toBe(a);
		expect(session.buffer).toBe(b);
		expect((await land()).error?.name).toBe('Conflict');
		expect(await session.settle()).toBe(true);
		expect(await readFile(file, 'utf8')).toBe(b);
	});

	test('newer typing while it lands late stays dirty against it: finding it saves nothing more', async () => {
		const { state, session, file, a, land } = await unconfirmedSave({
			landed: false,
		});
		const b = `${a}B\n`;
		session.input(b);
		expectOk(await land());
		await state.refresh();
		// Its own earlier text is the saved text now, not someone else's change.
		expect(session.attempt).toBeUndefined();
		expect(session.external).toBeUndefined();
		expect(session.saved.source).toBe(a);
		expect(session.buffer).toBe(b);
		expect(session.status).toBe('dirty');
		// The read sent nothing: the file still holds the first text.
		expect(await readFile(file, 'utf8')).toBe(a);
		expect(await session.settle()).toBe(true);
		expect(await readFile(file, 'utf8')).toBe(b);
	});

	test('other text found meanwhile is shown beside it; neither it nor the draft is lost, and the same save is all that is sent', async () => {
		const { state, session, note, file, a, land } = await unconfirmedSave({
			landed: false,
		});
		await writeFile(file, OUTSIDE);
		await state.refresh();
		expect(session.status).toBe('unconfirmed');
		expect(session.attempt).toMatchObject({
			source: a,
			kind: 'replace',
			expectedSha256: note.sha256,
			state: 'unconfirmed',
		});
		expect(session.external).toMatchObject({ current: { source: OUTSIDE } });
		expect(session.saved.source).toBe(note.source);
		expect(session.buffer).toBe(a);
		expect(await session.settle()).toBe(false);
		await session.retry();
		expect(await readFile(file, 'utf8')).toBe(OUTSIDE);
		expect(session.attempt).toMatchObject({ source: a, state: 'unconfirmed' });
		expect((await land()).error?.name).toBe('Conflict');
		expect(await readFile(file, 'utf8')).toBe(OUTSIDE);
	});
});

// ============================================================================
// A rename or delete of an open file whose reply is lost
// ============================================================================

describe('a rename or delete of an open file whose reply is lost', () => {
	test('a rename keeps the session where it was, forgets nothing on refresh, and changes nothing more', async () => {
		const { state, folder, root, seedNote, notePaths } = await product();
		const note = await seedNote();
		const session = await opened(state, note.path);
		loseNext(folder, 'move', { landed: true });
		expect(await state.rename(note.path, 'renamed.md')).toContain(
			'not confirmed',
		);
		// On disk the rename happened.
		expect(await readFile(join(root, 'notes/renamed.md'), 'utf8')).toBe(
			note.source,
		);
		await expect(stat(join(root, note.path))).rejects.toThrow();
		// The page does not know that. The session stays, under its old path.
		expect(state.sessionAt(note.path)).toBe(session);
		expect(state.selectedPath).toBe(note.path);
		expect(session.pathChange).toMatchObject({
			kind: 'move',
			from: { path: note.path, sha256: note.sha256 },
			to: 'notes/renamed.md',
			state: 'unconfirmed',
		});
		expect(state.notSaved).toBe(0);
		expect(draftsLineOf(state).label).toBe('1 change not confirmed');
		await state.refresh();
		expect(state.sessionAt(note.path)).toBe(session);
		expect(session.external).toBeUndefined();
		// Typing is kept and saved nowhere; nothing else is done to either path.
		const typed = `${note.source}typed after the rename\n`;
		expect(session.input(typed)).toBe(true);
		expect(await state.settleAll()).toBe(1);
		await session.retry();
		expect(await state.rename(note.path, 'other.md')).toBe(
			'Save or discard the open edits first.',
		);
		expect((await state.deletionFor(note.path)).error).toBe(
			'Save or discard the open edits first.',
		);
		state.discardDraft(note.path);
		expect(state.sessionAt(note.path)).toBe(session);
		expect(session.buffer).toBe(typed);
		expect(await readFile(join(root, 'notes/renamed.md'), 'utf8')).toBe(
			note.source,
		);
		expect(await notePaths()).toEqual(['notes/renamed.md']);
	});

	test('a delete keeps the session and the draft, and changes nothing more, whether or not the file is gone', async () => {
		for (const landed of [true, false]) {
			const { state, folder, root, seedNote } = await product();
			const note = await seedNote();
			const session = await opened(state, note.path);
			const deletion = expectOk(await state.deletionFor(note.path));
			const land = loseNext(folder, 'remove', { landed });
			expect(await state.remove(deletion)).toContain('not confirmed');
			expect(state.sessionAt(note.path)).toBe(session);
			expect(session.pathChange).toMatchObject({
				kind: 'remove',
				from: { path: note.path, sha256: note.sha256 },
				state: 'unconfirmed',
			});
			await state.refresh();
			expect(state.sessionAt(note.path)).toBe(session);
			expect(state.notSaved).toBe(0);
			expect(session.input(`${note.source}typed after\n`)).toBe(true);
			expect(await state.settleAll()).toBe(1);
			expect(await state.remove(deletion)).toBe(
				'Save or discard the open edits first.',
			);
			if (landed) await expect(stat(join(root, note.path))).rejects.toThrow();
			else {
				// Nothing wrote the path again, so the one delete that was sent can land.
				expect(await readFile(join(root, note.path), 'utf8')).toBe(note.source);
				expectOk(await land());
				await expect(stat(join(root, note.path))).rejects.toThrow();
			}
			expect(session.pathChange?.state).toBe('unconfirmed');
		}
	});
});

// ============================================================================
// A change to a file with no open session whose reply is lost
// ============================================================================

describe('a change with no open file whose reply is lost', () => {
	test('a new note is not reported as failed and not made again under another name; it is found when it appears', async () => {
		const { state, folder, notePaths } = await product();
		const land = loseNext(folder, 'create', { landed: false });
		expect(await state.createNote()).toContain('not confirmed');
		const [change] = state.pending;
		expect(change).toMatchObject({
			kind: 'create',
			label: 'New note',
			state: 'unconfirmed',
		});
		if (change?.kind !== 'create') throw new Error('No creation is pending');
		expect(state.notSaved).toBe(0);
		expect(draftsLineOf(state).label).toBe('1 change not confirmed');
		// Asking again makes no second note with a fresh name.
		expect(await state.createNote()).toContain('earlier new note');
		expect(await notePaths()).toEqual([]);
		// A refresh that finds nothing there proves nothing.
		await state.refresh();
		expect(state.pending).toEqual([change]);
		// The one creation that was sent arrives.
		expectOk(await land());
		await state.refresh();
		expect(state.pending).toEqual([]);
		expect(await notePaths()).toEqual([change.path]);
		// Now a second note is a second note.
		expect(await state.createNote()).toBeUndefined();
		expect(await notePaths()).toHaveLength(2);
	});

	test('a new note that never arrives can be sent again exactly, to the same path, and the late one is refused', async () => {
		const { state, folder, root, notePaths } = await product();
		const land = loseNext(folder, 'create', { landed: false });
		await state.createNote();
		const [change] = state.pending;
		if (change?.kind !== 'create') throw new Error('No creation is pending');
		expect(await state.retryPending(change)).toBeUndefined();
		expect(state.pending).toEqual([]);
		expect(await notePaths()).toEqual([change.path]);
		expect(await readFile(join(root, change.path), 'utf8')).toBe(change.source);
		expect((await land()).error?.name).toBe('Exists');
		expect(await notePaths()).toEqual([change.path]);
	});

	test('a field change is kept as it was sent, blocks another change to that file, and ends only on exactly its text', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const other = await seedNote('Other');
		await state.refresh();
		const land = loseNext(folder, 'replace', { landed: false });
		const pinned = note.source.replace('pinned: false', 'pinned: true');
		expect(await state.patchNote(note.path, { pinned: true })).toContain(
			'not confirmed',
		);
		expect(state.pending).toMatchObject([
			{
				kind: 'replace',
				base: { path: note.path, sha256: note.sha256 },
				source: pinned,
				state: 'unconfirmed',
			},
		]);
		expect(state.sessionAt(note.path)).toBeUndefined();
		// Nothing else is changed at that path from here; another file is unaffected.
		expect(await state.trashNote(note.path)).toContain('not confirmed');
		expect(await state.rename(note.path, 'renamed.md')).toContain(
			'not confirmed',
		);
		expect((await state.deletionFor(note.path)).error).toContain(
			'not confirmed',
		);
		expect(await state.patchNote(other.path, { pinned: true })).toBeUndefined();
		// It gets no editor either: a save from one could land on either side.
		await state.open(note.path);
		expect(state.sessionAt(note.path)).toBeUndefined();
		expect(state.selection).toMatchObject({
			kind: 'file',
			file: { kind: 'failed' },
		});
		// Other text there is not the text that was asked for.
		await writeFile(join(root, note.path), OUTSIDE);
		await state.refresh();
		expect(state.pending).toHaveLength(1);
		const [change] = state.pending;
		if (change === undefined) throw new Error('Nothing is pending');
		expect(await state.retryPending(change)).toContain('The file changed');
		expect(state.pending).toHaveLength(1);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(OUTSIDE);
		// The old file comes back, and the one replace that was sent lands.
		await writeFile(join(root, note.path), note.source);
		await state.refresh();
		expect(state.pending).toHaveLength(1);
		expectOk(await land());
		await state.refresh();
		expect(state.pending).toEqual([]);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(pinned);
		// Accounted for: the file opens and changes again.
		const session = await opened(state, note.path);
		expect(session.buffer).toBe(pinned);
		expect(await state.trashNote(note.path)).toBeUndefined();
	});

	test('a rename stays pending whatever is read, cannot be sent again, and blocks both names', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('a.txt', 'A\n'));
		await state.refresh();
		loseNext(folder, 'move', { landed: true });
		expect(await state.rename('a.txt', 'b.txt')).toContain('not confirmed');
		expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('A\n');
		await state.refresh();
		const [change] = state.pending;
		expect(change).toMatchObject({
			kind: 'move',
			from: { path: 'a.txt' },
			to: 'b.txt',
			state: 'unconfirmed',
		});
		if (change === undefined) throw new Error('Nothing is pending');
		expect(await state.retryPending(change)).toContain('cannot be sent again');
		expect(await state.rename('b.txt', 'c.txt')).toContain('not confirmed');
		expect((await state.deletionFor('b.txt')).error).toContain('not confirmed');
		expect(await state.createFile('', 'a.txt')).toContain('not confirmed');
		expect(state.pending).toEqual([change]);
		expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('A\n');
	});

	test('a delete stays pending, is not sent again, and the file is not deleted a second way', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('a.txt', 'A\n'));
		await state.refresh();
		const deletion = expectOk(await state.deletionFor('a.txt'));
		const land = loseNext(folder, 'remove', { landed: false });
		expect(await state.remove(deletion)).toContain('not confirmed');
		const [change] = state.pending;
		expect(change).toMatchObject({ kind: 'remove', state: 'unconfirmed' });
		if (change === undefined) throw new Error('Nothing is pending');
		expect(await state.remove(deletion)).toContain('not confirmed');
		expect((await state.deletionFor('a.txt')).error).toContain('not confirmed');
		await state.refresh();
		expect(state.pending).toEqual([change]);
		expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('A\n');
		expectOk(await land());
		await state.refresh();
		// The file is gone. Nothing read can say the delete will not run again.
		expect(state.pending).toHaveLength(1);
	});

	test('a new directory is found when it appears', async () => {
		const { state, folder } = await product();
		loseNext(folder, 'mkdir', { landed: true });
		expect(await state.createDirectory('', 'drafts')).toContain(
			'not confirmed',
		);
		await state.refresh();
		expect(state.pending).toEqual([]);
		expect(state.listing?.directories).toContain('drafts');
	});

	test('a directory call that throws is kept as not confirmed, and a known refusal stays definite', async () => {
		const { state, folder, root } = await product();
		// The call lands and then rejects, as an adapter that lost its reply can.
		const mkdir = folder.files.mkdir;
		folder.files.mkdir = async (path) => {
			await mkdir(path);
			throw new Error('the webview lost its IPC connection');
		};
		expect(await state.createDirectory('', 'drafts')).toContain(
			'not confirmed',
		);
		expect(state.pending).toMatchObject([
			{ kind: 'mkdir', path: 'drafts', state: 'unconfirmed' },
		]);
		expect((await stat(join(root, 'drafts'))).isDirectory()).toBe(true);
		// Nothing else is made there, and it is not made again by itself.
		expect(await state.createFile('', 'drafts')).toContain('not confirmed');
		await state.refresh();
		expect(state.pending).toEqual([]);

		// A removal that throws is kept, and never clears by being read.
		const rmdir = folder.files.rmdir;
		folder.files.rmdir = async () => {
			throw 'ipc closed';
		};
		const deletion = expectOk(await state.deletionFor('drafts'));
		expect(await state.remove(deletion)).toContain('not confirmed');
		expect(state.pending).toMatchObject([
			{ kind: 'rmdir', path: 'drafts', state: 'unconfirmed' },
		]);
		await state.refresh();
		expect(state.pending).toHaveLength(1);
		expect((await stat(join(root, 'drafts'))).isDirectory()).toBe(true);

		// A directory that is not empty is refused outright: nothing is kept.
		folder.files.rmdir = rmdir;
		folder.files.mkdir = mkdir;
		expect(await state.createDirectory('', 'kept')).toBeUndefined();
		expectOk(await folder.files.create('kept/a.txt', 'A\n'));
		expect(await state.remove({ kind: 'folder', path: 'kept' })).toBe(
			'The folder is not empty, so nothing was deleted.',
		);
		expect(state.pending).toHaveLength(1);
	});

	test('a pending change counts toward a close, and so does one still being sent', async () => {
		const { state, folder, notePaths } = await product();
		// One that is still being sent.
		const held = holdNext(folder, 'create');
		const creating = state.createNote();
		await held.asked;
		expect(state.unsettled).toBe(1);
		expect(draftsLineOf(state).label).toBe('Saving…');
		// A close fences first, then waits for what was already sent.
		const release = state.fenceInput();
		let settled: number | undefined;
		const settling = state.settleAll().then((remaining) => {
			settled = remaining;
		});
		await Promise.resolve();
		expect(settled).toBeUndefined();
		held.release();
		await settling;
		expect(settled).toBe(0);
		expect(await creating).toBeUndefined();
		expect(await notePaths()).toHaveLength(1);
		release();

		// One whose reply is lost.
		loseNext(folder, 'create', { landed: false });
		expect(await state.createNote()).toContain('not confirmed');
		expect(state.unsettled).toBe(1);
		expect(await state.settleAll()).toBe(1);
		expect(draftsLineOf(state).label).toBe('1 change not confirmed');
	});

	test('a rename still reading its file when input is fenced is not sent', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('a.txt', 'A\n'));
		await state.refresh();
		const read = folder.files.read;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		folder.files.read = async (path) => {
			started.resolve();
			await release.promise;
			return read(path);
		};
		let moves = 0;
		const move = folder.files.move;
		folder.files.move = (...args) => {
			moves += 1;
			return move(...args);
		};
		const renaming = state.rename('a.txt', 'b.txt');
		await started.promise;
		state.fenceInput();
		let remaining: number | undefined;
		const settling = state.settleAll().then((count) => {
			remaining = count;
		});
		await Promise.resolve();
		expect(remaining).toBeUndefined();
		release.resolve();
		await settling;
		expect(remaining).toBe(0);
		expect(await renaming).toContain('closing');
		expect(moves).toBe(0);
		expect(state.pending).toEqual([]);
		expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('A\n');
		await expect(stat(join(root, 'b.txt'))).rejects.toThrow();
	});
});

// Parent counterexample: an editor must not bypass a retained noneditor intent.
test('a file opened during a noneditor write cannot publish after that write becomes uncertain', async () => {
	const { state, folder, seedNote } = await product();
	const note = await seedNote();
	await state.refresh();
	const asked = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<void>();
	const replace = folder.files.replace;
	let calls = 0;
	folder.files.replace = async (file, source) => {
		calls += 1;
		if (calls === 1) {
			asked.resolve();
			await reply.promise;
			return FileError.Unconfirmed({
				path: file.path,
				operation: 'publishing to',
				cause: new Error('reply lost'),
			});
		}
		return replace(file, source);
	};
	const changing = state.patchNote(note.path, { pinned: true });
	await asked.promise;
	await state.open(note.path);
	const session = state.sessionAt(note.path);
	if (session !== undefined)
		session.input(note.source.replace('Hello', 'Newer typing'));
	reply.resolve();
	expect(await changing).toContain('not confirmed');
	if (session !== undefined) await session.save();
	expect(calls).toBe(1);
});

test('an uncertain recovery destination remains owned by the original draft', async () => {
	const { state, folder, root, seedNote } = await product();
	const note = await seedNote();
	const session = await opened(state, note.path);
	session.input(note.source.replace('Hello', 'Recovery typing'));
	await rm(join(root, note.path));
	await state.refresh();
	expect(session.external?.kind).toBe('removed');
	await writeFile(join(root, note.path), OUTSIDE);
	const create = folder.files.create;
	folder.files.create = async (path, source) => {
		const answer = await create(path, source);
		if (path !== note.path && answer.error === null)
			return FileError.Unconfirmed({
				path,
				operation: 'publishing to',
				cause: new Error('reply lost'),
			});
		return answer;
	};
	expect(await state.recoverDraft(note.path)).toContain('not confirmed');
	const attempt = session.attempt;
	const target = attempt?.path;
	if (attempt === undefined || target === undefined || target === note.path)
		throw new Error('No alternate recovery was submitted');
	await state.open(target);
	expect(state.sessionAt(target)).toBeUndefined();
	expect(state.sessionAt(note.path)).toBe(session);
	expect(session.buffer).toContain('Recovery typing');
	expect(await readFile(join(root, target), 'utf8')).toBe(attempt.source);
});

test('close fences new changes and waits for a note creation already sent', async () => {
	const { state, folder, host, root } = await product();
	const held = holdNext(folder, 'create');
	const creating = state.createNote();
	await held.asked;
	let detached = false;
	const detach = host.close;
	host.close = async () => {
		detached = true;
		await detach();
	};
	const closing = state.close();
	expect(await state.createNote()).toContain('closing');
	await Promise.resolve();
	expect(detached).toBe(false);
	held.release();
	expect(await creating).toBeUndefined();
	await closing;
	expect(detached).toBe(true);
	expect(
		(await readdir(join(root, 'notes'))).filter((path) => path.endsWith('.md')),
	).toHaveLength(1);
});
