/**
 * Notes Over A Real Directory Tests
 *
 * Runs the notes state, its note sessions, and its raw file sessions against
 * a real temporary directory with automatic history disabled. Explicit
 * history checks use the real `git`. The folder is the folder package's
 * directory opener, with the same handle the desktop page receives from the
 * shell, and its own row editors, so these cover what Honeycrisp does with a
 * folder, not how the page reaches one. A note's save that waits or loses its
 * reply is in `row-session.test.ts`; the real editor cannot be made to.
 *
 * Key behaviors:
 * - Reading or opening a note never rewrites it; a note's save writes the
 *   complete canonical document: unknown values stay, comments and spelling do not
 * - A Git failure is history, never a save error
 * - A dirty note survives another writer and keeps its draft until the person chooses
 * - A note file the row editor cannot hold is repaired as text, then opens as a note
 * - A path owns one session across selection, rename, and deletion; a renamed
 *   note's draft, typing during the move included, goes to an editor at the new path
 * - Rename and delete act on the capture the session holds, for notes and
 *   raw files alike
 * - A raw draft whose file was removed is saved back as the text it captured,
 *   and what another program writes afterwards stays that program's
 * - A change whose reply is lost is not confirmed, never "not saved". A raw
 *   save is sent again as it was and reconciles only on exactly its own text.
 *   A rename or delete stays as it was sent. A change with no open file is
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
import { type FileCapture, FileError, inspectRow } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/bun';
import { Ok, type Result } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import {
	honeycrispDefinition,
	type NoteEntry,
	noteIdOf,
	repairReason,
} from './data.js';
import type { FileSession } from './file-session.svelte.js';
import { noteBody } from './note-source.js';
import type { NoteSession } from './notes.svelte.js';
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
 * The notes state over a new directory with automatic history disabled.
 * Editor tests do not wait for background commits; explicit history is
 * exercised through the app.
 */
async function product() {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'honeycrisp-notes-')),
	);
	const handle = expectOk(
		await openFolder({
			root,
			definition: honeycrispDefinition,
			git: {
				author: { name: 'Honeycrisp', email: 'honeycrisp@localhost' },
				commitOnEdit: false,
			},
		}),
	);
	await setUpFolder(handle.files, Object.keys(honeycrispDefinition.tables));
	// Mutable copies let a test hold or lose replies from the real folder.
	const { notes, folders } = handle.tables;
	const folder: NotesFolder = {
		tables: {
			notes: {
				list: notes.list,
				create: notes.create,
				edit: notes.edit,
				update: notes.update,
			},
			folders: {
				list: folders.list,
				create: folders.create,
				update: folders.update,
			},
		},
		files: { ...handle.files },
		git: handle.git,
		// This folder hints at its own saves, not at other programs' writes.
		onFilesChanged: handle.onFilesChanged,
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
		close: () => handle.close(),
	};
	cleanup.push(async () => {
		await handle.close();
		await rm(root, { recursive: true, force: true });
	});
	const git = (...args: string[]) =>
		spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
	/** A note already in the folder, as another session of the app would have left it. */
	const seedNote = async (title = 'First') => {
		const { stem } = expectOk(
			await handle.tables.notes.create({
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
		);
		// A write receipt carries no reading; the note is what a read returns.
		return expectOk(await handle.tables.notes.get(stem)) as NoteEntry;
	};
	let repairs = 0;
	/**
	 * A note file whose text does not parse, so it opens as text to repair:
	 * its draft is a raw session at a note path.
	 */
	const seedRepair = async () => {
		repairs += 1;
		const path = `notes/repair-${repairs}.md`;
		const source = '---\ntitle: [open\n---\nHello\n';
		expectOk(await handle.files.create(path, source));
		const sha256 = expectOk(await handle.files.read(path)).sha256;
		return { path, source, sha256 };
	};
	/** The note files in the folder now. */
	const notePaths = async () =>
		expectOk(await handle.tables.notes.list()).map((item) => item.path);
	const state = createNotes(host);
	cleanup.push(() => state.close());
	await state.refreshAll();
	return {
		host,
		folder,
		handle,
		root,
		git,
		seedNote,
		seedRepair,
		notePaths,
		ran,
		state,
	};
}

type State = Awaited<ReturnType<typeof product>>['state'];

/** A file opened in the notes state as text, with its raw session. */
async function openedFile(state: State, path: string): Promise<FileSession> {
	await state.refresh();
	await state.open(path);
	const session = state.sessionAt(path);
	if (session === undefined) throw new Error(`${path} did not open as text`);
	return session;
}

/** A note opened in the notes state, with its note session. */
async function openedNote(state: State, path: string): Promise<NoteSession> {
	await state.refresh();
	await state.open(path);
	const session = state.noteAt(path);
	if (session === undefined) throw new Error(`${path} did not open as a note`);
	return session;
}

/** Replace a note's body as its views do. */
const typeBody = (session: NoteSession, body: string) =>
	noteBody(() => session).input(body);

/** The drafts line as the header derives it. */
const draftsLineOf = (state: State) =>
	draftsLine({
		saving: state.saving,
		notSaved: state.notSaved,
		unconfirmed: state.unconfirmed,
		unsettled: state.unsettled,
	});

type ChangingVerb =
	| 'create'
	| 'update'
	| 'replace'
	| 'move'
	| 'remove'
	| 'mkdir';
type Reply = Promise<
	| { data: unknown; error: null }
	| { data: null; error: { name: string; message: string } }
>;
type Callable = Record<string, unknown>;

/**
 * Holds the next call of `verb` on `target` (the folder's files, or a table)
 * before it is published. `asked` resolves when it has been asked for;
 * `release()` lets it go ahead.
 */
function holdNext(target: object, verb: string) {
	const methods = target as Callable;
	const real = methods[verb] as (...args: unknown[]) => Reply;
	const asked = Promise.withResolvers<void>();
	const held = Promise.withResolvers<void>();
	let done = false;
	methods[verb] = async (...args: unknown[]) => {
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
 * Loses the reply to the next call of `verb` on `target`, as the desktop
 * folder reports a reply that never arrives. With `landed`, the real change
 * runs first. Without it nothing changes until the returned `land()` runs
 * that same call, with the arguments it was given.
 */
function loseNext(
	target: object,
	verb: ChangingVerb,
	{ landed }: { landed: boolean },
) {
	const methods = target as Callable;
	const real = methods[verb] as (...args: unknown[]) => Reply;
	const pending: { land?: () => Reply } = {};
	methods[verb] = async (...args: unknown[]) => {
		if (pending.land !== undefined) return real(...args);
		pending.land = () => real(...args);
		if (landed) await pending.land();
		const [first] = args;
		return FileError.Unconfirmed({
			path:
				typeof first === 'string'
					? first
					: typeof (first as FileCapture).path === 'string'
						? (first as FileCapture).path
						: 'notes',
			operation: 'publishing to',
			cause: new Error('the webview lost its IPC connection'),
		});
	};
	return () => {
		if (pending.land === undefined) throw new Error(`No ${verb} was sent`);
		return pending.land();
	};
}

/**
 * Loses the reply to the save of the next note editor the app opens. With
 * `landed`, the save is written first. `held` keeps the reply back until it
 * resolves. `land()` writes what the lost save submitted.
 */
function loseNextSave(
	folder: NotesFolder,
	write: (path: string, source: string) => Promise<Result<unknown, unknown>>,
	{ landed, held }: { landed: boolean; held?: Promise<void> },
) {
	const edit = folder.tables.notes.edit;
	const asked = Promise.withResolvers<void>();
	let lost: { path: string; source: string } | undefined;
	let saves = 0;
	folder.tables.notes.edit = async (stem, options) => {
		const opened = await edit(stem, options);
		if (opened.error !== null || lost !== undefined) return opened;
		const editor = opened.data;
		return Ok({
			...editor,
			async save() {
				saves += 1;
				const { path, text: source } = editor.get();
				lost = { path, source };
				asked.resolve();
				await held;
				if (landed) await editor.save();
				return FileError.Unconfirmed({
					path,
					operation: 'publishing to',
					cause: new Error('the webview lost its IPC connection'),
				});
			},
		});
	};
	return {
		asked: asked.promise,
		get saves() {
			return saves;
		},
		land() {
			if (lost === undefined) throw new Error('No save was sent');
			return write(lost.path, lost.source);
		},
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
	test('a new note opens its row editor and an explicit app commit records it', async () => {
		const { state, root, git } = await product();
		expect(await state.createNote()).toBeUndefined();
		const path = state.selectedPath as string;
		expect(path).toMatch(/^notes\/[0-9a-z]+\.md$/);
		const source = await readFile(join(root, path), 'utf8');
		expect(inspectRow(honeycrispDefinition.tables.notes, source)).toMatchObject(
			{
				parseError: undefined,
				issues: [],
				fields: { title: '', folderId: null, pinned: false, deletedAt: null },
			},
		);
		const session = state.noteAt(path);
		expect(session?.status).toBe('saved');
		expect(state.selection?.kind).toBe('note');
		expect(state.notes.map((entry) => entry.path)).toEqual([path]);
		expect(state.notes[0] && repairReason(state.notes[0])).toBeUndefined();
		expect(state.pending).toEqual([]);
		expect((await state.commitNow()).status).toBe('committed');
		expect(git('show', `HEAD:${path}`)).toBe(source.trim());
	});

	test('listing, opening, and reading a note never rewrite it, however it is spelled', async () => {
		const { state, folder, root } = await product();
		const path = join(root, 'notes', 'odd.md');
		const bytes = Buffer.from(
			[
				'---',
				'# written by hand',
				"title:   'Spaced'  # keep",
				'extra: [1, 2]',
				'deletedAt: null',
				'pinned: false',
				'folderId: null',
				'createdAt: "2026-10-01T00:00:00.000Z"',
				'updatedAt: "2026-10-01T00:00:00.000Z"',
				'---',
				'',
				'* a',
				'* b',
				'',
			].join('\r\n'),
		);
		await writeFile(path, bytes);
		const before = await stat(path);
		await folder.tables.notes.list();
		await folder.files.read('notes/odd.md');
		const session = await openedNote(state, 'notes/odd.md');
		expect(session.dirty).toBe(false);
		expect(session.state.reading.fields.title).toBe('Spaced');
		expect(await session.settle()).toBe(true);
		await state.refresh();
		expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
		expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
	});

	test('a save writes the complete canonical document: unknown values stay, comments and spelling do not', async () => {
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
		const file = join(root, 'notes', 'keep.md');
		await writeFile(file, source);
		const session = await openedNote(state, 'notes/keep.md');
		expect(typeBody(session, '\n# New\n\n- [x] done\n')).toBe(true);
		expect(await session.settle()).toBe(true);
		const saved = await readFile(file, 'utf8');
		const updatedAt = session.state.reading.fields.updatedAt;
		expect(updatedAt).not.toBe('2026-10-01T00:00:00.000Z');
		expect(saved).toBe(
			[
				'---',
				'"folderId": null',
				'"title": "Quoted title"',
				'"pinned": false',
				'"createdAt": "2026-10-01T00:00:00.000Z"',
				`"updatedAt": ${JSON.stringify(updatedAt)}`,
				'"deletedAt": null',
				'"custom": {"nested": [1, 2]}',
				'"tags": ["one"]',
				'---',
				'',
				'# New',
				'',
				'- [x] done',
				'',
			].join('\n'),
		);
		expect(inspectRow(honeycrispDefinition.tables.notes, saved).issues).toEqual(
			[],
		);
		// Reading the saved file again agrees with it and writes nothing.
		const before = await stat(file);
		await state.refresh();
		expect(session.status).toBe('saved');
		expect(session.dirty).toBe(false);
		expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
	});

	test('assigning a note keeps its path, and deleting its folder clears the reference and removes the folder file', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		await state.refresh();
		expect(await state.createFolder('Work')).toBeUndefined();
		const [made] = state.folders;
		if (made === undefined) throw new Error('The folder is not listed');
		expect(await readFile(join(root, made.path), 'utf8')).toBe(
			'---\nname: Work\nicon: null\n---\n',
		);
		expect(
			await state.patchNote(note.path, { folderId: made.stem }),
		).toBeUndefined();
		const moved = state.notes.find((entry) => entry.path === note.path);
		expect(moved && moved.fields.folderId).toBe(made.stem);
		expect(state.notes).toHaveLength(1);
		// A folder's name is a field change too; the rest of its text stays.
		expect(await state.patchFolder(made, { name: 'Projects' })).toBeUndefined();
		expect(await readFile(join(root, made.path), 'utf8')).toBe(
			'---\nname: Projects\nicon: null\n---\n',
		);
		const renamed = state.folders.find((entry) => entry.path === made.path);
		if (renamed === undefined) throw new Error('The folder is not listed');
		expect(await state.deleteFolder(renamed)).toBeUndefined();
		expect(state.folders).toEqual([]);
		expect(state.notes[0] && state.notes[0].fields.folderId).toBeNull();
		await expect(stat(join(root, made.path))).rejects.toThrow();
		expect(await readFile(join(root, note.path), 'utf8')).toBe(note.text);
	});

	test('a folder with an unusual or empty file name is an ordinary folder: its stem is its id, and it deletes like any other', async () => {
		const { state, root, seedNote } = await product();
		const inOdd = await seedNote('In odd');
		const inEmpty = await seedNote('In empty');
		const unfiled = await seedNote('Unfiled');
		const source = '---\nname: Odd\nicon: null\n---\n';
		for (const name of ['bad .md', '.md'])
			await writeFile(join(root, 'folders', name), source);
		await state.refresh();
		const bad = state.folders.find((entry) => entry.path === 'folders/bad .md');
		const empty = state.folders.find((entry) => entry.path === 'folders/.md');
		if (bad === undefined || empty === undefined)
			throw new Error('The folders are not listed');
		expect([bad.stem, empty.stem]).toEqual(['bad ', '']);
		// A name is an address, never something to repair.
		for (const folder of [bad, empty])
			expect(repairReason(folder)).toBeUndefined();

		// The literal stem is the reference, including the empty one.
		expect(
			await state.patchNote(inOdd.path, { folderId: bad.stem }),
		).toBeUndefined();
		expect(
			await state.patchNote(inEmpty.path, { folderId: empty.stem }),
		).toBeUndefined();
		const folderOf = (path: string) => {
			const note = state.notes.find((entry) => entry.path === path);
			return note && note.fields.folderId;
		};
		expect(folderOf(inOdd.path)).toBe('bad ');
		expect(folderOf(inEmpty.path)).toBe('');
		expect(await readFile(join(root, inEmpty.path), 'utf8')).toContain(
			'folderId: ""',
		);

		// Deleting the empty-stem folder moves out its note, and only its note.
		expect(await state.deleteFolder(empty)).toBeUndefined();
		await expect(stat(join(root, empty.path))).rejects.toThrow();
		expect(folderOf(inEmpty.path)).toBeNull();
		expect(folderOf(inOdd.path)).toBe('bad ');
		expect(folderOf(unfiled.path)).toBeNull();
		expect(await state.deleteFolder(bad)).toBeUndefined();
		await expect(stat(join(root, bad.path))).rejects.toThrow();
		expect(folderOf(inOdd.path)).toBeNull();
	});

	test('a folder is not deleted while a note cannot say which folder it is in; other fields do not matter', async () => {
		const { state, root, seedNote } = await product();
		const member = await seedNote('Member');
		expect(await state.createFolder('Work')).toBeUndefined();
		const [work] = state.folders;
		if (work === undefined) throw new Error('The folder is not listed');
		expect(
			await state.patchNote(member.path, { folderId: work.stem }),
		).toBeUndefined();
		const memberSource = await readFile(join(root, member.path), 'utf8');
		const untouched = async () => {
			expect(await readFile(join(root, work.path), 'utf8')).toContain('Work');
			expect(await readFile(join(root, member.path), 'utf8')).toBe(
				memberSource,
			);
		};

		// Each of these might be in the folder: its text names it, or might.
		const unknown: Record<string, string | Uint8Array> = {
			'unparsed.md': `---\nfolderId: ${work.stem}\ntitle: [open\n---\n`,
			'fenceless.md': `folderId: ${work.stem}\n`,
			'invalid.md': '---\nfolderId: 12\ntitle: Odd\n---\n',
			'absent.md': '---\ntitle: No folder field\n---\n',
			'binary.md': new Uint8Array([0xff, 0xfe, 0x00]),
		};
		for (const [name, content] of Object.entries(unknown)) {
			await writeFile(join(root, 'notes', name), content);
			await state.refresh();
			const refusal = await state.deleteFolder(work);
			expect(refusal).toContain('cannot be read well enough');
			expect(refusal).toContain(name);
			await untouched();
			await rm(join(root, 'notes', name));
		}

		// A note with issues in other fields still says where it is: that is
		// enough to leave it alone, or to move it out with its other text kept.
		const inside = `---\nfolderId: "${work.stem}" # filed\ntitle: 12\nowner: 'sam'\n---\nBody\n`;
		await writeFile(join(root, 'notes', 'inside.md'), inside);
		await writeFile(
			join(root, 'notes', 'elsewhere.md'),
			'---\nfolderId: null\ntitle: 12\n---\n',
		);
		await state.refresh();
		expect(await state.deleteFolder(work)).toBeUndefined();
		await expect(stat(join(root, work.path))).rejects.toThrow();
		expect(await readFile(join(root, member.path), 'utf8')).toBe(
			memberSource.replace(/^folderId: .*$/m, 'folderId: null'),
		);
		expect(await readFile(join(root, 'notes', 'inside.md'), 'utf8')).toBe(
			inside.replace(`folderId: "${work.stem}"`, 'folderId: null'),
		);
	});

	test('a note id is the literal stem of a row directly in notes, and may be empty', () => {
		expect(noteIdOf('notes/a.b.md')).toBe('a.b');
		expect(noteIdOf('notes/bad .md')).toBe('bad ');
		expect(noteIdOf('notes/.md')).toBe('');
		for (const path of ['notes/a/b.md', 'notes/a.txt', 'notes/a.MD', 'a.md'])
			expect(noteIdOf(path)).toBeUndefined();
	});
});

// ============================================================================
// Git failures are history
// ============================================================================

test('a Git failure leaves the file saved and is reported as history, not as a save error', async () => {
	const { state, root, git, seedNote } = await product();
	const note = await seedNote();
	const session = await openedNote(state, note.path);
	// The save finishes before an explicit app commit meets the branch lock.
	await writeFile(join(root, '.git', 'refs', 'heads', 'main.lock'), '');
	typeBody(session, 'Locked out\n');
	expect(await session.saveNow()).toBeUndefined();
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
// Saves that fail
// ============================================================================

describe('a note save that fails', () => {
	test('keeps the draft, stops saving by itself, and saves again when the person asks', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const notes = join(root, 'notes');
		spawnSync('chmod', ['a-w', notes]);
		cleanup.push(async () => {
			spawnSync('chmod', ['u+w', notes]);
		});
		typeBody(session, 'Not yet saved\n');
		expect(await session.settle()).toBe(false);
		expect(session.status).toBe('failed');
		expect(state.notSaved).toBe(1);
		expect(session.state.document.body).toBe('Not yet saved\n');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(note.text);
		// More typing is kept, and nothing is sent by itself.
		typeBody(session, 'Still not saved\n');
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(await readFile(join(root, note.path), 'utf8')).toBe(note.text);
		expect(await state.settleAll()).toBe(1);
		spawnSync('chmod', ['u+w', notes]);
		expect(await session.saveNow()).toBeUndefined();
		expect(session.status).toBe('saved');
		expect(await readFile(join(root, note.path), 'utf8')).toContain(
			'Still not saved',
		);
		expect(await state.settleAll()).toBe(0);
	});
});

// ============================================================================
// Other writers
// ============================================================================

describe('other writers', () => {
	test('a dirty draft survives an external edit, and saving over it is the person’s choice', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		typeBody(session, 'Mine\n');
		await writeFile(
			join(root, note.path),
			note.text.replace('Hello', 'Theirs'),
		);
		await state.refresh();
		expect(session.status).toBe('conflict');
		expect(session.state.document.body).toBe('Mine\n');
		expect(session.external?.kind).toBe('present');
		// Nothing saves by itself over the other program's text.
		expect(await session.settle()).toBe(false);
		expect(await readFile(join(root, note.path), 'utf8')).toContain('Theirs');
		expect(await session.saveNow()).toBeUndefined();
		expect(session.status).toBe('saved');
		expect(await readFile(join(root, note.path), 'utf8')).toContain('Mine');
	});

	test('a reviewed version is taken only while it is still the file’s content', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		typeBody(session, 'Mine\n');
		await writeFile(join(root, note.path), note.text.replace('Hello', 'B'));
		await state.refresh();
		const reviewed = session.external;
		if (reviewed?.kind !== 'present')
			throw new Error('No conflict was recorded');
		const newer = note.text.replace('Hello', 'C');
		await writeFile(join(root, note.path), newer);
		await state.refresh();
		expect(session.adopt(reviewed.revision)).toBe(false);
		expect(session.state.document.body).toBe('Mine\n');
		const current = session.external;
		if (current?.kind !== 'present')
			throw new Error('No conflict was recorded');
		expect(session.adopt(current.revision)).toBe(true);
		expect(session.state.document.body).toBe('C\n');
		expect(session.status).toBe('saved');
		// Taking the file wrote nothing.
		expect(await readFile(join(root, note.path), 'utf8')).toBe(newer);
	});

	test('a malformed file is still a note to select, saves while malformed, and is repaired as text, then opens as a note', async () => {
		const { state, root } = await product();
		const malformed = '---\ntitle: *missing\n---\nbody\n';
		await writeFile(join(root, 'notes', 'bad.md'), malformed);
		await writeFile(join(root, 'notes', 'plain.md'), 'No frontmatter\n');
		await writeFile(
			join(root, 'notes', 'binary.md'),
			new Uint8Array([0xff, 0xfe, 0x00]),
		);
		await state.refresh();
		// Text that does not parse is listed with its source; bytes that are not
		// text are listed apart, with no entry invented for them.
		const listed = (path: string) =>
			state.notes.find((entry) => entry.path === path);
		for (const path of ['notes/bad.md', 'notes/plain.md']) {
			expect(listed(path)?.parseError).toBeDefined();
			expect(listed(path)?.body).toBeUndefined();
			expect(repairReason(listed(path) as NoteEntry)).toBeDefined();
		}
		expect(listed('notes/bad.md')?.text).toBe(malformed);
		expect(state.unreadable.map((item) => item.path)).toEqual([
			'notes/binary.md',
		]);

		const session = await openedFile(state, 'notes/bad.md');
		expect(state.noteAt('notes/bad.md')).toBeUndefined();
		expect(state.selection?.kind).toBe('file');
		expect(session.buffer).toBe(malformed);
		// A structured change is refused and writes nothing: the text session
		// owns the file, and a file not open is not a note the editor can hold.
		expect(await state.patchNote('notes/bad.md', { pinned: true })).toContain(
			'open as text',
		);
		expect(await state.patchNote('notes/plain.md', { pinned: true })).toContain(
			'needs repair',
		);
		expect(await readFile(join(root, 'notes/plain.md'), 'utf8')).toBe(
			'No frontmatter\n',
		);
		expect(await readFile(join(root, 'notes/bad.md'), 'utf8')).toBe(malformed);
		// It is not a note yet.
		expect(await state.openAsNote('notes/bad.md')).toContain(
			'cannot be opened as a note',
		);
		// Still malformed text saves as written, and stays selectable.
		const still = malformed.replace('body', 'more body');
		session.input(still);
		await session.save();
		expect(session.status).toBe('saved');
		expect(await readFile(join(root, 'notes/bad.md'), 'utf8')).toBe(still);
		await state.refresh();
		expect(listed('notes/bad.md')?.text).toBe(still);
		expect(listed('notes/bad.md')?.parseError).toBeDefined();

		session.input(OUTSIDE.replace('title: Outside', 'title: Fixed'));
		await session.save();
		await state.refresh();
		const repaired = listed('notes/bad.md') as NoteEntry;
		expect(repaired.fields.title).toBe('Fixed');
		expect(await state.openAsNote('notes/bad.md')).toBeUndefined();
		expect(state.sessionAt('notes/bad.md')).toBeUndefined();
		expect(state.noteAt('notes/bad.md')?.state.reading.fields.title).toBe(
			'Fixed',
		);
		expect(state.selection?.kind).toBe('note');
	});

	test('a note can be edited as a file, for keys its controls do not show, and opened as a note again', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		typeBody(session, 'Unsaved\n');
		// Nothing typed is set aside: the draft is saved first.
		expect(await state.editAsFile(note.path)).toBeUndefined();
		expect(state.noteAt(note.path)).toBeUndefined();
		const raw = state.sessionAt(note.path);
		if (raw === undefined) throw new Error('The note did not open as text');
		expect(raw.buffer).toBe(await readFile(join(root, note.path), 'utf8'));
		expect(raw.buffer).toContain('Unsaved');
		raw.input(
			raw.buffer.replace('---\nUnsaved', '"owner": "sam"\n---\nUnsaved'),
		);
		await raw.save();
		expect(await state.openAsNote(note.path)).toBeUndefined();
		const again = state.noteAt(note.path);
		expect(again?.state.document.fields.owner).toBe('sam');
		expect(state.sessionAt(note.path)).toBeUndefined();
	});
});

// ============================================================================
// Slow raw saves
// ============================================================================

describe('slow raw saves', () => {
	test('a held save stays saving, then meets an outside write as a conflict', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('scratch.txt', 'Hello\n'));
		const session = await openedFile(state, 'scratch.txt');
		const write = holdNext(folder.files, 'replace');
		session.input('Held\n');
		const saving = session.save();
		await write.asked;
		expect(session.status).toBe('saving');
		expect(await readFile(join(root, 'scratch.txt'), 'utf8')).toBe('Hello\n');
		await writeFile(join(root, 'scratch.txt'), 'Outside\n');
		write.release();
		await saving;
		expect(session.status).toBe('conflict');
		expect(session.buffer).toBe('Held\n');
		expect(await readFile(join(root, 'scratch.txt'), 'utf8')).toBe('Outside\n');
	});

	test('typing during a save stays a draft: the save acknowledges only what it submitted', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('scratch.txt', 'Hello\n'));
		const session = await openedFile(state, 'scratch.txt');
		const write = holdNext(folder.files, 'replace');
		session.input('A\n');
		const saving = session.save();
		await write.asked;
		expect(session.status).toBe('saving');
		session.input('A and B\n');
		write.release();
		await saving;
		expect(session.saved.text).toBe('A\n');
		expect(session.buffer).toBe('A and B\n');
		expect(session.dirty).toBe(true);
		expect(await readFile(join(root, 'scratch.txt'), 'utf8')).toBe('A\n');
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
		const noteSession = state.noteAt(note.path);
		await state.open('scratch.txt');
		const rawSession = state.sessionAt('scratch.txt');
		await state.open(note.path);
		expect(state.selection?.kind).toBe('note');
		expect(state.noteAt(note.path)).toBe(noteSession);
		expect(state.sessionAt(note.path)).toBeUndefined();
		await state.open('scratch.txt');
		expect(state.selection?.kind).toBe('file');
		expect(state.sessionAt('scratch.txt')).toBe(rawSession);
		expect(state.unsettled).toBe(0);
	});

	test('renaming an edited raw file keeps its session and writes only to the new path', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('scratch.txt', 'raw\n'));
		const session = await openedFile(state, 'scratch.txt');
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

	test('renaming an edited note saves it, then an editor at the new name takes the draft and its place', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const view = state.selection?.kind === 'note' && state.selection.key;
		typeBody(session, 'Edited before rename\n');
		expect(await state.rename(note.path, 'renamed.md')).toBeUndefined();
		expect(state.noteAt(note.path)).toBeUndefined();
		const renamed = state.noteAt('notes/renamed.md');
		if (renamed === undefined) throw new Error('No note at the new name');
		expect(renamed).not.toBe(session);
		// The view stays mounted, with its undo history, on the new session.
		expect(state.selection?.kind === 'note' && state.selection.key).toBe(view);
		expect(renamed.state.document).toEqual(session.state.document);
		expect(renamed.status).toBe('saved');
		expect(state.selectedPath).toBe('notes/renamed.md');
		expect(state.selection?.kind).toBe('note');
		expect(state.notes.map((entry) => entry.path)).toEqual([
			'notes/renamed.md',
		]);
		expect(await readFile(join(root, 'notes/renamed.md'), 'utf8')).toContain(
			'Edited before rename',
		);
		await expect(stat(join(root, note.path))).rejects.toThrow();
		expect(await state.rename('notes/renamed.md', 'renamed.txt')).toBe(
			'A note file keeps its .md extension.',
		);
	});

	test('typing during a rename goes to the editor at the new name, and nothing is written to the old one', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const move = holdNext(folder.files, 'move');
		const renaming = state.rename(note.path, 'renamed.md');
		await move.asked;
		expect(session.status).toBe('saving');
		expect(typeBody(session, 'Typed during the rename\n')).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(await readFile(join(root, note.path), 'utf8')).toBe(note.text);
		move.release();
		expect(await renaming).toBeUndefined();
		const renamed = state.noteAt('notes/renamed.md');
		if (renamed === undefined) throw new Error('No note at the new name');
		expect(renamed.state.document.body).toBe('Typed during the rename\n');
		expect(await renamed.settle()).toBe(true);
		expect(await readFile(join(root, 'notes/renamed.md'), 'utf8')).toContain(
			'Typed during the rename',
		);
		await expect(stat(join(root, note.path))).rejects.toThrow();
	});

	test('deleting an edited raw file captures its saved version and forgets only that session', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('scratch.txt', 'raw\n'));
		const session = await openedFile(state, 'scratch.txt');
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

	test('deleting an edited note saves it, captures that version, and forgets the note', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		typeBody(session, 'Saved before deleting\n');
		const deletion = expectOk(await state.deletionFor(note.path));
		expect(deletion).toEqual({
			kind: 'file',
			file: { path: note.path, sha256: session.state.baseline.sha256 },
			title: 'First',
		});
		expect(await readFile(join(root, note.path), 'utf8')).toContain(
			'Saved before deleting',
		);
		expect(await state.remove(deletion)).toBeUndefined();
		expect(state.noteAt(note.path)).toBeUndefined();
		expect(state.selectedPath).toBeUndefined();
		await expect(stat(join(root, note.path))).rejects.toThrow();
	});

	test('a raw file changed after deletion was confirmed is kept with its session', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('scratch.txt', 'raw\n'));
		const session = await openedFile(state, 'scratch.txt');
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
		const session = await openedNote(state, shown.path);
		const outside = (note: NoteEntry) =>
			note.text.replace('Hello', 'Written by another program');
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
		await session.refresh();
		expect(state.noteAt(shown.path)).toBe(session);
		expect(session.state.document.body).toBe('Written by another program\n');
		expect(state.pending).toEqual([]);
	});

	test('a raw file renamed into a note keeps its session, and opens as a note once it is one', async () => {
		const { state, folder, root } = await product();
		const source =
			'---\ntitle: Before\n# keep this comment\nunknown: "keep"\n---\nBody\n';
		expectOk(await folder.files.create('notes/raw.txt', source));
		const session = await openedFile(state, 'notes/raw.txt');
		expect(await state.rename('notes/raw.txt', 'raw.md')).toBeUndefined();
		expect(state.sessionAt('notes/raw.md')).toBe(session);
		expect(state.selection?.kind).toBe('file');
		expect(state.isNote('notes/raw.md')).toBe(true);
		// The text session owns it, so no structured change is made.
		expect(await state.patchNote('notes/raw.md', { title: 'After' })).toContain(
			'open as text',
		);
		session.input(
			OUTSIDE.replace(
				'title: Outside',
				'# keep this comment\nunknown: "keep"\ntitle: Before',
			),
		);
		await session.save();
		expect(await state.openAsNote('notes/raw.md')).toBeUndefined();
		expect(
			await state.patchNote('notes/raw.md', { title: 'After' }),
		).toBeUndefined();
		const saved = await readFile(join(root, 'notes/raw.md'), 'utf8');
		expect(saved).toContain('"title": "After"');
		expect(saved).toContain('"unknown": "keep"');
		expect(saved).not.toContain('# keep this comment');
	});

	test('a dirty note survives malformed external source, refuses rename, and its draft is discarded only by choice', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		typeBody(session, 'my unsaved text\n');
		await writeFile(
			join(root, note.path),
			'---\ntitle: [broken\n---\noutside\n',
		);
		await state.refresh();
		expect(state.noteAt(note.path)).toBe(session);
		expect(session.state.document.body).toBe('my unsaved text\n');
		// Text that does not parse has no canonical form either.
		const seen = session.external?.kind;
		expect(seen === 'invalid' || seen === 'unsupported').toBe(true);
		expect(await state.rename(note.path, 'renamed.md')).toBe(
			'Save or discard the open edits first.',
		);
		expect(await readFile(join(root, note.path), 'utf8')).toContain('[broken');
		// Discarding the draft opens the file to repair, as text.
		state.discardDraft(note.path);
		expect(state.noteAt(note.path)).toBeUndefined();
		expect(state.sessionAt(note.path)?.buffer).toContain('[broken');
	});

	test('a clean note whose file stops being one it can hold opens as text to repair', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		await openedNote(state, note.path);
		await writeFile(join(root, note.path), '---\ntitle: [broken\n---\n');
		await state.refresh();
		expect(state.noteAt(note.path)).toBeUndefined();
		expect(state.sessionAt(note.path)?.buffer).toBe(
			'---\ntitle: [broken\n---\n',
		);
		expect(state.selection?.kind).toBe('file');
	});

	test('metadata changes share the open session, with explicit deferred and immediate saves', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		expect(
			await state.patchNote(
				note.path,
				{ title: 'Typed title' },
				{ save: 'later' },
			),
		).toBeUndefined();
		expect(session.state.reading.fields.title).toBe('Typed title');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(note.text);
		expect(await state.patchNote(note.path, { pinned: true })).toBeUndefined();
		const saved = await readFile(join(root, note.path), 'utf8');
		expect(saved).toContain('"title": "Typed title"');
		expect(saved).toContain('"pinned": true');
		expect(state.noteAt(note.path)).toBe(session);
	});

	test('an unopened metadata action assigns its field in the text, keeps every other byte, and keeps no session', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const source = note.text.replace(
			'title: First',
			"title: 'First' # quoted\nowner: sam",
		);
		await writeFile(join(root, note.path), source);
		await state.refresh();
		expect(await state.patchNote(note.path, { pinned: true })).toBeUndefined();
		expect(state.noteAt(note.path)).toBeUndefined();
		expect(state.selectedPath).toBeUndefined();
		expect(state.pending).toEqual([]);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(
			source.replace('pinned: false', 'pinned: true'),
		);
	});

	test('an unopened note with another field to fix is pinned, trashed, and restored; text that does not parse is refused', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const source = note.text.replace('title: First', 'title: 12');
		await writeFile(join(root, note.path), source);
		await state.refresh();
		const listed = state.notes.find((entry) => entry.path === note.path);
		expect(listed && repairReason(listed)).toBeDefined();
		expect(await state.patchNote(note.path, { pinned: true })).toBeUndefined();
		expect(await state.trashNote(note.path)).toBeUndefined();
		const trashed = await readFile(join(root, note.path), 'utf8');
		expect(trashed).toContain('title: 12');
		expect(trashed).toContain('pinned: true');
		expect(trashed).not.toContain('deletedAt: null');
		expect(await state.restoreNote(note.path)).toBeUndefined();
		expect(await readFile(join(root, note.path), 'utf8')).toBe(
			source.replace('pinned: false', 'pinned: true'),
		);
		// Restoring a restored note publishes the same bytes: done, and unchanged.
		expect(await state.restoreNote(note.path)).toBeUndefined();
		expect(await readFile(join(root, note.path), 'utf8')).toBe(
			source.replace('pinned: false', 'pinned: true'),
		);
		await writeFile(join(root, note.path), '---\ntitle: [open\n---\n');
		await state.refresh();
		expect(await state.trashNote(note.path)).toContain('needs repair');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(
			'---\ntitle: [open\n---\n',
		);
		expect(state.pending).toEqual([]);
	});

	test('an unopened metadata action applies to the note as it is read now', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		await state.refresh();
		await writeFile(join(root, note.path), OUTSIDE);
		expect(await state.patchNote(note.path, { pinned: true })).toBeUndefined();
		expect(state.pending).toEqual([]);
		const saved = inspectRow(
			honeycrispDefinition.tables.notes,
			await readFile(join(root, note.path), 'utf8'),
		);
		expect(saved.fields).toMatchObject({ title: 'Outside', pinned: true });
		expect(saved.body).toBe('Written by another program\n');
	});

	test('a listing captured before a save cannot roll a saved repair draft back after the save', async () => {
		const { state, folder, root, seedRepair } = await product();
		const repair = await seedRepair();
		const session = await openedFile(state, repair.path);
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
		session.input(`${repair.source}saved while listing waits\n`);
		await session.save();
		const saved = session.saved;
		release.resolve();
		await refreshing;
		await new Promise((resolve) => setTimeout(resolve, 0));
		stop();
		expect(session.saved.sha256).toEqual(saved.sha256);
		expect(session.buffer).toBe(saved.text);
		expect(session.external).toBeUndefined();
		// A second old value means the screen actually rolled back, even if the
		// save's queued refresh eventually put the new value back.
		expect(observed.filter((source) => source === repair.source)).toHaveLength(
			1,
		);
		expect(await readFile(join(root, repair.path), 'utf8')).toBe(saved.text);
	});

	test('renaming a raw file refuses a destination with a kept removed-file draft', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('a.txt', 'A\n'));
		expectOk(await folder.files.create('b.txt', 'B\n'));
		const a = await openedFile(state, 'a.txt');
		const b = await openedFile(state, 'b.txt');
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
		const b = await openedFile(state, 'b.txt');
		b.input('Retained B\n');
		await rm(join(root, 'b.txt'));
		await state.refresh();
		// Another program puts a different file there before the draft is saved.
		await writeFile(join(root, 'b.txt'), 'Other\n');
		expect(await state.recoverDraft('b.txt')).toContain('The file changed');
		expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('Other\n');
		expect(b.buffer).toBe('Retained B\n');
		const reviewed = b.external;
		expect(reviewed).toMatchObject({ current: { text: 'Other\n' } });
		if (reviewed === undefined) throw new Error('No conflict was recorded');
		expect(await b.saveMine(reviewed)).toBe(true);
		expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('Retained B\n');
		expect((await folder.files.list()).data?.files.map((f) => f.path)).toEqual([
			'b.txt',
			'kv.json',
		]);
	});

	test('a deleted note’s draft is kept, and saving it writes it back at its own path', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		await rm(join(root, note.path));
		typeBody(session, 'Retained\n');
		await state.refresh();
		expect(state.noteAt(note.path)).toBe(session);
		expect(session.external?.kind).toBe('missing');
		expect(await session.settle()).toBe(false);
		await expect(stat(join(root, note.path))).rejects.toThrow();
		expect(await session.saveNow()).toBeUndefined();
		expect(await readFile(join(root, note.path), 'utf8')).toContain('Retained');
		expect(session.status).toBe('saved');
	});

	test('renaming a note also refuses a destination with a kept removed-note draft', async () => {
		const { state, root, seedNote } = await product();
		const a = await seedNote('A');
		const b = await seedNote('B');
		const aSession = await openedNote(state, a.path);
		const bSession = await openedNote(state, b.path);
		await rm(join(root, b.path));
		typeBody(bSession, 'Retained B\n');
		await state.refresh();
		expect(bSession.external?.kind).toBe('missing');
		expect(await state.rename(a.path, `${b.stem}.md`)).toContain('draft');
		expect(state.noteAt(a.path)).toBe(aSession);
		expect(state.noteAt(b.path)).toBe(bSession);
		expect(bSession.state.document.body).toBe('Retained B\n');
		expect(await readFile(join(root, a.path), 'utf8')).toBe(a.text);
		state.discardDraft(b.path);
		expect(state.noteAt(b.path)).toBeUndefined();
	});

	test('a refresh awaiting a raw read cannot forget a session renamed while it waits', async () => {
		const { state, folder } = await product();
		expectOk(await folder.files.create('scratch.txt', 'raw\n'));
		const session = await openedFile(state, 'scratch.txt');
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
		const session = await openedNote(state, note.path);
		typeBody(session, 'typed before the fence\n');
		const release = state.fenceInput();
		expect(state.fenced).toBe(true);
		expect(typeBody(session, 'typed late\n')).toBe(false);
		expect(await session.saveNow()).toContain('closing');
		expect(await state.patchNote(note.path, { pinned: true })).toContain(
			'closing',
		);
		expect(await state.createNote()).toContain('closing');
		expect(await state.createFolder('Work')).toContain('closing');
		expect(await state.createFile('', 'new.txt')).toContain('closing');
		expect(await state.createDirectory('', 'new')).toContain('closing');
		expect(await state.rename(note.path, 'renamed.md')).toContain('closing');
		expect(await state.editAsFile(note.path)).toContain('closing');
		expect((await state.deletionFor(note.path)).error).toContain('closing');
		expect(
			await state.remove({
				kind: 'file',
				file: { path: note.path, sha256: note.sha256 },
				title: undefined,
			}),
		).toContain('closing');
		expect(
			(
				await session.changePath(
					(from) => ({ kind: 'move', from, to: 'notes/renamed.md' }),
					async () => ({ kind: 'done', value: undefined }),
				)
			).kind,
		).toBe('unsettled');
		// What was already typed is still saved for the close.
		expect(await state.settleAll()).toBe(0);
		expect(await readFile(join(root, note.path), 'utf8')).toContain(
			'typed before the fence',
		);
		expect(state.notes).toHaveLength(1);
		release();
		expect(state.fenced).toBe(false);
		expect(typeBody(session, 'typed after\n')).toBe(true);
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
		const session = await openedNote(state, note.path);
		expect(session.dirty).toBe(false);
		// No refresh follows: the open session still holds the note as created.
		await writeFile(join(root, note.path), OUTSIDE);
		expect(await state.rename(note.path, 'renamed.md')).toContain(
			'The file changed',
		);
		await session.refresh();
		expect(await notePaths()).toEqual([note.path]);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(OUTSIDE);
		expect(session.state.document.body).toBe('Written by another program\n');
		expect(state.noteAt(note.path)).toBe(session);
	});

	test('renaming a raw file another program just rewrote is refused the same way', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('scratch.txt', 'raw\n'));
		const session = await openedFile(state, 'scratch.txt');
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
		const session = await openedNote(state, a.path);
		expect(await state.rename(a.path, `${b.stem}.md`)).toBe(
			`"${b.stem}.md" already exists here.`,
		);
		expect(state.noteAt(a.path)).toBe(session);
		expect(session.pathChange).toBeUndefined();
		expect(await readFile(join(root, a.path), 'utf8')).toBe(a.text);
		expect(await readFile(join(root, b.path), 'utf8')).toBe(b.text);
	});
});

// ============================================================================
// A removed repair draft
// ============================================================================

/**
 * A dirty draft of a note file being repaired as text, whose file was
 * deleted outside, ready to be written back. `afterCreate` runs once that
 * exclusive creation has landed and before its reply reaches the session;
 * `afterRefusal` runs when a creation is refused.
 */
async function removedRepairDraft({
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
	const { state, folder, root, seedRepair } = fixture;
	const repair = await seedRepair();
	const session = await openedFile(state, repair.path);
	const file = join(root, repair.path);
	await rm(file);
	const admitted = `${repair.source}Typed before the file was deleted\n`;
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
	return { ...fixture, session, path: repair.path, file, admitted, created };
}

describe('a removed repair draft', () => {
	test('writing it back never leaves the session agreeing with text another program put there next', async () => {
		const { state, session, path, file, admitted, created } =
			await removedRepairDraft({
				afterCreate: ({ file }) => writeFile(file, OUTSIDE),
			});
		// Every state the screen could have shown.
		const shown: { saved: string; buffer: string; conflict: boolean }[] = [];
		const stop = watch(() => {
			shown.push({
				saved: session.saved.text,
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
		const { state, session, path, file, admitted } = await removedRepairDraft({
			async afterCreate({ session, file }) {
				session.input(`${session.buffer}${typed}`);
				await writeFile(file, OUTSIDE);
			},
		});
		expect(await state.recoverDraft(path)).toBeUndefined();
		await state.refresh();
		expect(session.buffer).toBe(`${admitted}${typed}`);
		expect(session.external?.kind).toBe('changed');
		expect(session.external).toMatchObject({ current: { text: OUTSIDE } });
		expect(await session.settle()).toBe(false);
		expect(session.buffer).toBe(`${admitted}${typed}`);
		expect(await readFile(file, 'utf8')).toBe(OUTSIDE);
	});

	test('typing while it is written back stays a draft when nothing else writes', async () => {
		const typed = 'Typed while the note was being written back\n';
		const { state, session, path, file, admitted, created } =
			await removedRepairDraft({
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
			await removedRepairDraft({
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

	test('a write back that landed with its reply lost is the file’s content, stays not confirmed, and saving again makes no second note', async () => {
		const { state, folder, session, path, file, admitted, notePaths } =
			await removedRepairDraft();
		loseNext(folder.files, 'create', { landed: true });
		expect(await state.recoverDraft(path)).toContain('not confirmed');
		await state.refresh();
		expect(await readFile(file, 'utf8')).toBe(admitted);
		// Exactly the attempted text is at its path: that is what the file holds.
		// Which write put it there is not known, so the save stays unconfirmed.
		expect(session.saved.text).toBe(admitted);
		expect(session.attempt).toMatchObject({
			path,
			source: admitted,
			state: 'unconfirmed',
		});
		expect(session.status).toBe('unconfirmed');
		expect(state.notSaved).toBe(0);
		expect(await state.settleAll()).toBe(1);
		// Saving again is a new write over that text, at the same path.
		expect(await state.recoverDraft(path)).toBeUndefined();
		expect(session.status).toBe('saved');
		expect(await notePaths()).toEqual([path]);
	});

	test('a write back not yet in the folder stays unconfirmed, and saving again sends what is on screen to the same path', async () => {
		const { state, folder, session, path, file, admitted, notePaths } =
			await removedRepairDraft();
		const land = loseNext(folder.files, 'create', { landed: false });
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
		// Nothing was sent by itself; the person saves again.
		expect(await readFile(file, 'utf8').catch(() => undefined)).toBeUndefined();
		expect(await state.recoverDraft(path)).toBeUndefined();
		expect(session.saved.text).toBe(b);
		expect(session.attempt).toBeUndefined();
		// The first creation arrives late and is refused by its own condition.
		expect((await land()).error?.name).toBe('Exists');
		expect(await readFile(file, 'utf8')).toBe(b);
		expect(await notePaths()).toEqual([path]);
	});

	test('a first creation that lands between two presses does not leave the draft in two notes, and stays not confirmed', async () => {
		const { state, folder, session, path, file, admitted, notePaths } =
			await removedRepairDraft();
		const land = loseNext(folder.files, 'create', { landed: false });
		await state.recoverDraft(path);
		await expect(stat(file)).rejects.toThrow();
		expectOk(await land());
		expect(await readFile(file, 'utf8')).toBe(admitted);
		const b = `${admitted}B\n`;
		session.input(b);
		// The occupant is the earlier text: no second note is made, and the
		// earlier save is still not known to be the one that put it there.
		expect(await state.recoverDraft(path)).toContain('not confirmed');
		expect(session.path).toBe(path);
		expect(session.attempt).toMatchObject({
			source: admitted,
			state: 'unconfirmed',
		});
		expect(session.saved.text).toBe(admitted);
		expect(session.buffer).toBe(b);
		expect(await notePaths()).toEqual([path]);
		// Nothing more is sent by itself.
		expect(await session.settle()).toBe(false);
		expect(await readFile(file, 'utf8')).toBe(admitted);
		// The person saves again, over what the file holds.
		expect(await state.recoverDraft(path)).toBeUndefined();
		expect(await readFile(file, 'utf8')).toBe(b);
		expect(await notePaths()).toEqual([path]);
	});

	test('other text at the path while a write back is unconfirmed is shown beside it, and no second note is made', async () => {
		const { state, folder, session, path, file, admitted, notePaths } =
			await removedRepairDraft();
		const land = loseNext(folder.files, 'create', { landed: false });
		await state.recoverDraft(path);
		await writeFile(file, OUTSIDE);
		expect(await state.recoverDraft(path)).toContain('not confirmed');
		expect(session.external).toMatchObject({ current: { text: OUTSIDE } });
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
// A raw save whose reply is lost
// ============================================================================

describe('a raw save whose reply is lost', () => {
	/**
	 * A repair draft whose save of `a` gets no reply. With `landed`, the file
	 * was written first. Without it the file is unchanged until `land()` runs
	 * that same conditional replace.
	 */
	async function unconfirmedSave({ landed }: { landed: boolean }) {
		const fixture = await product();
		const { state, folder, root, seedRepair } = fixture;
		const note = await seedRepair();
		const session = await openedFile(state, note.path);
		const land = loseNext(folder.files, 'replace', { landed });
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

	test('one that landed is the file’s content when read: no conflict and no "not saved", and still not confirmed', async () => {
		const { state, session, file, a } = await unconfirmedSave({ landed: true });
		await state.refresh();
		expect(await readFile(file, 'utf8')).toBe(a);
		expect(session.saved.text).toBe(a);
		expect(session.attempt).toMatchObject({ source: a, state: 'unconfirmed' });
		expect(session.external).toBeUndefined();
		expect(session.status).toBe('unconfirmed');
		expect(state.notSaved).toBe(0);
		expect(draftsLineOf(state).label).toBe('1 change not confirmed');
		// The person keeps the file: the hold ends, and nothing is sent.
		expect(session.keepFile()).toBe(true);
		expect(session.status).toBe('saved');
		expect(draftsLineOf(state).label).toBe('No unsaved drafts');
		expect(await readFile(file, 'utf8')).toBe(a);
	});

	test('one holding an unpaired surrogate is kept as the text of the bytes it sent, and those bytes are the file’s content when they land', async () => {
		const { state, folder, root, seedRepair } = await product();
		const note = await seedRepair();
		const session = await openedFile(state, note.path);
		const file = join(root, note.path);
		const land = loseNext(folder.files, 'replace', { landed: false });
		const typed = `${note.source}lone \uD800\n`;
		const stored = typed.replace('\uD800', '�');
		session.input(typed);
		await session.save();
		expect(session.attempt).toMatchObject({
			path: note.path,
			source: stored,
			kind: 'replace',
			expectedSha256: note.sha256,
			state: 'unconfirmed',
		});
		// Nothing is known to be saved, so the draft is as it was typed.
		expect(session.buffer).toBe(typed);
		expectOk(await land());
		await state.refresh();
		expect(await readFile(file, 'utf8')).toBe(stored);
		expect(session.saved.text).toBe(stored);
		expect(session.saved.sha256).toBe(
			expectOk(await folder.files.read(note.path)).sha256,
		);
		expect(session.buffer).toBe(stored);
		expect(session.status).toBe('unconfirmed');
		expect(await state.settleAll()).toBe(1);
	});

	test('a read that still finds the old file does not mean it failed; when it lands, the read says what the file holds and nothing more', async () => {
		const { state, session, note, file, a, land } = await unconfirmedSave({
			landed: false,
		});
		// Everything the page can read says the old file is still there.
		await state.refresh();
		expect(await readFile(file, 'utf8')).toBe(note.source);
		expect(session.status).toBe('unconfirmed');
		expect(session.saved.text).toBe(note.source);
		expect(state.notSaved).toBe(0);
		// The same save is published afterwards, with no further action.
		expectOk(await land());
		await state.refresh();
		expect(await readFile(file, 'utf8')).toBe(a);
		expect(session.saved.text).toBe(a);
		expect(session.status).toBe('unconfirmed');
		expect(state.unconfirmed).toBe(1);
	});

	test('newer typing is held: saving again before it lands sends what is on screen, and the late save is refused', async () => {
		const { session, file, a, land } = await unconfirmedSave({ landed: false });
		const b = `${a}B\n`;
		session.input(b);
		// Saving is held while the outcome is unknown.
		expect(await session.settle()).toBe(false);
		expect(await readFile(file, 'utf8')).not.toContain('A\n');
		await session.retry();
		expect(await readFile(file, 'utf8')).toBe(b);
		expect(session.saved.text).toBe(b);
		expect(session.attempt).toBeUndefined();
		expect((await land()).error?.name).toBe('Conflict');
		expect(await readFile(file, 'utf8')).toBe(b);
	});

	test('newer typing while it lands late stays a draft against it: finding it saves nothing', async () => {
		const { state, session, file, a, land } = await unconfirmedSave({
			landed: false,
		});
		const b = `${a}B\n`;
		session.input(b);
		expectOk(await land());
		await state.refresh();
		// The earlier text is the file's content now, not someone else's change,
		// and the save that sent it is still not confirmed.
		expect(session.attempt).toMatchObject({ source: a, state: 'unconfirmed' });
		expect(session.external).toBeUndefined();
		expect(session.saved.text).toBe(a);
		expect(session.buffer).toBe(b);
		expect(session.status).toBe('unconfirmed');
		// The read sent nothing, and settling sends nothing either.
		expect(await session.settle()).toBe(false);
		expect(await readFile(file, 'utf8')).toBe(a);
		// The person saves again.
		await session.retry();
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
		expect(session.external).toMatchObject({ current: { text: OUTSIDE } });
		expect(session.saved.text).toBe(note.source);
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
// A rename or delete of an open note whose reply is lost
// ============================================================================

describe('a rename or delete of an open note whose reply is lost', () => {
	test('a rename keeps the session where it was, forgets nothing on refresh, and changes nothing more', async () => {
		const { state, folder, root, seedNote, notePaths } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		loseNext(folder.files, 'move', { landed: true });
		expect(await state.rename(note.path, 'renamed.md')).toContain(
			'not confirmed',
		);
		// On disk the rename happened.
		expect(await readFile(join(root, 'notes/renamed.md'), 'utf8')).toBe(
			note.text,
		);
		await expect(stat(join(root, note.path))).rejects.toThrow();
		// The page does not know that. The session stays, under its old path.
		expect(state.noteAt(note.path)).toBe(session);
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
		expect(state.noteAt(note.path)).toBe(session);
		// Typing is kept and saved nowhere; nothing else is done to either path.
		expect(typeBody(session, 'typed after the rename\n')).toBe(true);
		expect(await state.settleAll()).toBe(1);
		expect(await session.saveNow()).toContain('not finished');
		expect(await state.rename(note.path, 'other.md')).toBe(
			'Save or discard the open edits first.',
		);
		expect((await state.deletionFor(note.path)).error).toBe(
			'Save or discard the open edits first.',
		);
		expect(await state.editAsFile(note.path)).toBe(
			'Save or discard the open edits first.',
		);
		state.discardDraft(note.path);
		expect(state.noteAt(note.path)).toBe(session);
		expect(session.state.document.body).toBe('typed after the rename\n');
		expect(await readFile(join(root, 'notes/renamed.md'), 'utf8')).toBe(
			note.text,
		);
		expect(await notePaths()).toEqual(['notes/renamed.md']);
	});

	test('a delete keeps the session and the draft, and changes nothing more, whether or not the file is gone', async () => {
		for (const landed of [true, false]) {
			const { state, folder, root, seedNote } = await product();
			const note = await seedNote();
			const session = await openedNote(state, note.path);
			const deletion = expectOk(await state.deletionFor(note.path));
			const land = loseNext(folder.files, 'remove', { landed });
			expect(await state.remove(deletion)).toContain('not confirmed');
			expect(state.noteAt(note.path)).toBe(session);
			expect(session.pathChange).toMatchObject({
				kind: 'remove',
				from: { path: note.path, sha256: note.sha256 },
				state: 'unconfirmed',
			});
			await state.refresh();
			expect(state.noteAt(note.path)).toBe(session);
			expect(state.notSaved).toBe(0);
			expect(typeBody(session, 'typed after\n')).toBe(true);
			expect(await state.settleAll()).toBe(1);
			expect(await state.remove(deletion)).toBe(
				'Save or discard the open edits first.',
			);
			if (landed) await expect(stat(join(root, note.path))).rejects.toThrow();
			else {
				// Nothing wrote the path again, so the one delete that was sent can land.
				expect(await readFile(join(root, note.path), 'utf8')).toBe(note.text);
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
	test('a new note is not reported as failed and not made again under another name; finding it ends nothing until the person dismisses it', async () => {
		const { state, folder, notePaths } = await product();
		const land = loseNext(folder.tables.notes, 'create', { landed: false });
		expect(await state.createNote()).toContain('not confirmed');
		const [change] = state.pending;
		expect(change).toMatchObject({
			kind: 'createRow',
			table: 'notes',
			label: 'New note',
			state: 'unconfirmed',
		});
		if (change?.kind !== 'createRow') throw new Error('No creation is pending');
		expect(state.notSaved).toBe(0);
		expect(draftsLineOf(state).label).toBe('1 change not confirmed');
		// Asking again makes no second note with a fresh name.
		expect(await state.createNote()).toContain('earlier new note');
		expect(await notePaths()).toEqual([]);
		// A refresh that finds nothing there proves nothing.
		await state.refresh();
		expect(state.pending).toEqual([change]);
		expect(state.found(change)).toBe(false);
		// The one creation that was sent arrives. The folder shows it; that
		// does not say this request made it, so the record stays.
		expectOk(await land());
		await state.refresh();
		expect(await notePaths()).toEqual([change.path]);
		expect(state.pending).toEqual([change]);
		expect(state.found(change)).toBe(true);
		expect(await state.createNote()).toContain('earlier new note');
		// The person dismisses it. Now a second note is a second note.
		state.dismissPending(change);
		expect(state.pending).toEqual([]);
		expect(await state.createNote()).toBeUndefined();
		expect(await notePaths()).toHaveLength(2);
	});

	test('a new note that never arrives can be created again under the same name, and the late one is refused', async () => {
		const { state, folder, notePaths } = await product();
		const land = loseNext(folder.tables.notes, 'create', { landed: false });
		await state.createNote();
		const [change] = state.pending;
		if (change?.kind !== 'createRow') throw new Error('No creation is pending');
		expect(await state.retryPending(change)).toBeUndefined();
		expect(state.pending).toEqual([]);
		expect(await notePaths()).toEqual([change.path]);
		expect((await land()).error?.name).toBe('Exists');
		expect(await notePaths()).toEqual([change.path]);
	});

	test('a new folder that appears is shown as found, and stays until dismissed', async () => {
		const { state, folder } = await product();
		const land = loseNext(folder.tables.folders, 'create', { landed: false });
		expect(await state.createFolder('Work')).toContain('not confirmed');
		const [change] = state.pending;
		expect(change).toMatchObject({
			kind: 'createRow',
			table: 'folders',
			fields: { name: 'Work' },
		});
		if (change === undefined) throw new Error('Nothing is pending');
		expectOk(await land());
		await state.refresh();
		expect(state.folders.map((entry) => entry.fields.name)).toEqual(['Work']);
		expect(state.found(change)).toBe(true);
		expect(state.pending).toEqual([change]);
		state.dismissPending(change);
		expect(state.pending).toEqual([]);
	});

	test('a field change is kept, blocks another change to that file, and stays after the file holds what it asked for until dismissed', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const other = await seedNote('Other');
		await state.refresh();
		const update = folder.tables.notes.update;
		let updates = 0;
		folder.tables.notes.update = (...args) => {
			if (args[0] === note.stem) updates += 1;
			return update(...args);
		};
		const land = loseNext(folder.tables.notes, 'update', { landed: false });
		expect(await state.patchNote(note.path, { pinned: true })).toContain(
			'not confirmed',
		);
		expect(state.pending).toMatchObject([
			{
				kind: 'changeRow',
				table: 'notes',
				path: note.path,
				fields: { pinned: true },
				options: {},
				state: 'unconfirmed',
			},
		]);
		expect(state.noteAt(note.path)).toBeUndefined();
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
		expect(state.noteAt(note.path)).toBeUndefined();
		expect(state.selection).toMatchObject({
			kind: 'file',
			file: { kind: 'failed' },
		});
		// Other text there is not what was asked for.
		await writeFile(join(root, note.path), OUTSIDE);
		await state.refresh();
		const [change] = state.pending;
		if (change === undefined) throw new Error('Nothing is pending');
		expect(state.found(change)).toBe(false);
		// The one change that was sent lands, on the file as it is then. The
		// file holds what was asked for; the record stays until the person
		// dismisses it.
		expectOk(await land());
		await state.refresh();
		expect(state.pending).toEqual([change]);
		expect(state.found(change)).toBe(true);
		await state.open(note.path);
		expect(state.noteAt(note.path)).toBeUndefined();
		expect(updates).toBe(1);
		state.dismissPending(change);
		// Accounted for by the person: the note opens and changes again.
		const session = await openedNote(state, note.path);
		expect(session.state.reading.fields.pinned).toBe(true);
		expect(await state.trashNote(note.path)).toBeUndefined();
	});

	test('asking for a lost field change again assigns it in the note as it is now', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		await state.refresh();
		loseNext(folder.tables.notes, 'update', { landed: false });
		await state.patchNote(note.path, { pinned: true });
		const [change] = state.pending;
		if (change === undefined) throw new Error('Nothing is pending');
		await writeFile(join(root, note.path), OUTSIDE);
		expect(await state.retryPending(change)).toBeUndefined();
		expect(state.pending).toEqual([]);
		const saved = inspectRow(
			honeycrispDefinition.tables.notes,
			await readFile(join(root, note.path), 'utf8'),
		);
		expect(saved.fields).toMatchObject({ title: 'Outside', pinned: true });
	});

	test('a rename stays pending whatever is read, cannot be sent again, and blocks both names', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('a.txt', 'A\n'));
		await state.refresh();
		loseNext(folder.files, 'move', { landed: true });
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
		const land = loseNext(folder.files, 'remove', { landed: false });
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

	test('a new directory that appears is shown as found, and stays until dismissed', async () => {
		const { state, folder } = await product();
		loseNext(folder.files, 'mkdir', { landed: true });
		expect(await state.createDirectory('', 'drafts')).toContain(
			'not confirmed',
		);
		await state.refresh();
		const [change] = state.pending;
		if (change === undefined) throw new Error('Nothing is pending');
		expect(state.found(change)).toBe(true);
		expect(state.listing?.directories).toContain('drafts');
		state.dismissPending(change);
		expect(state.pending).toEqual([]);
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
		const [made] = state.pending;
		if (made === undefined) throw new Error('Nothing is pending');
		// The directory is there; only the person ends the record.
		expect(state.found(made)).toBe(true);
		state.dismissPending(made);
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
		const held = holdNext(folder.tables.notes, 'create');
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
		loseNext(folder.tables.notes, 'create', { landed: false });
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

// A pending file mutation blocks acquiring a competing editor.
test('opening a note during a change with no editor refuses an editor before the reply is lost', async () => {
	const { state, folder, seedNote } = await product();
	const note = await seedNote();
	await state.refresh();
	loseNext(folder.tables.notes, 'update', { landed: false });
	const reply = holdNext(folder.tables.notes, 'update');
	const changing = state.patchNote(note.path, { pinned: true });
	await reply.asked;
	await state.open(note.path);
	expect(state.noteAt(note.path)).toBeUndefined();
	expect(state.sessionAt(note.path)).toBeUndefined();
	reply.release();
	expect(await changing).toContain('not confirmed');
	await state.open(note.path);
	expect(state.noteAt(note.path)).toBeUndefined();
});

test('an uncertain recovery destination remains owned by the original draft', async () => {
	const { state, folder, root, seedRepair } = await product();
	const note = await seedRepair();
	const session = await openedFile(state, note.path);
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
	expect(state.noteAt(target)).toBeUndefined();
	expect(state.sessionAt(note.path)).toBe(session);
	expect(session.buffer).toContain('Recovery typing');
	expect(await readFile(join(root, target), 'utf8')).toBe(attempt.source);
});

test('close fences new changes and waits for a note creation already sent', async () => {
	const { state, folder, host, root } = await product();
	const held = holdNext(folder.tables.notes, 'create');
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

test('close waits for a note save already admitted, and nothing typed after the fence is taken', async () => {
	const { state, root, seedNote } = await product();
	const note = await seedNote();
	const session = await openedNote(state, note.path);
	typeBody(session, 'Typed before the close\n');
	const saving = session.saveNow();
	const closing = state.close();
	expect(typeBody(session, 'Typed during the close\n')).toBe(false);
	await saving;
	await closing;
	expect(await readFile(join(root, note.path), 'utf8')).toContain(
		'Typed before the close',
	);
});

// ============================================================================
// Holds, ownership, and closing
// ============================================================================

describe('what a note session holds until the person chooses', () => {
	test('a failed save stays held when another program writes the same text, and the note is not handed on', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const notes = join(root, 'notes');
		spawnSync('chmod', ['a-w', notes]);
		cleanup.push(async () => {
			spawnSync('chmod', ['u+w', notes]);
		});
		typeBody(session, 'Mine\n');
		expect(await session.settle()).toBe(false);
		expect(session.status).toBe('failed');
		// Another program writes exactly the draft, in place.
		await writeFile(join(root, note.path), session.state.text);
		await state.refresh();
		// The file holds the draft now. That answers nothing about the save.
		expect(session.dirty).toBe(false);
		expect(session.state.lastSave?.kind).toBe('failed');
		expect(session.status).toBe('failed');
		expect(session.paused).toBe(true);
		expect(session.unsettled).toBe(true);
		expect(await state.settleAll()).toBe(1);
		// Nothing hands the note to another owner past the hold.
		expect(await state.editAsFile(note.path)).toBe(
			'Save or discard the open edits first.',
		);
		expect(state.sessionAt(note.path)).toBeUndefined();
		expect(state.noteAt(note.path)).toBe(session);
		expect(await state.rename(note.path, 'renamed.md')).toBe(
			'Save or discard the open edits first.',
		);
		expect((await state.deletionFor(note.path)).error).toBe(
			'Save or discard the open edits first.',
		);
		// The person keeps the file as it is. The hold ends; the history stays.
		const seen = session.state.observation;
		if (seen.kind !== 'present') throw new Error('Expected a present file');
		expect(session.adopt(seen.revision)).toBe(true);
		expect(session.state.lastSave?.kind).toBe('failed');
		expect(session.unsettled).toBe(false);
		expect(await state.settleAll()).toBe(0);
	});

	test('a clean text file whose unknown rename stopped being tracked stays held when its old path reads as missing', async () => {
		const { state, folder, root } = await product();
		expectOk(await folder.files.create('scratch.txt', 'raw\n'));
		const session = await openedFile(state, 'scratch.txt');
		loseNext(folder.files, 'move', { landed: true });
		expect(await state.rename('scratch.txt', 'renamed.txt')).toContain(
			'not confirmed',
		);
		expect(session.dirty).toBe(false);
		expect(state.stopTracking('scratch.txt')).toBeUndefined();
		// The old path reads as missing. That is where the file is not, not
		// where it went, and it is no choice: the session stays, held.
		await state.refresh();
		expect(state.sessionAt('scratch.txt')).toBe(session);
		expect(session.detached).toMatchObject({
			kind: 'move',
			from: { path: 'scratch.txt' },
			to: 'renamed.txt',
			state: 'unconfirmed',
		});
		expect(session.external).toEqual({ kind: 'removed' });
		expect(session.unsettled).toBe(true);
		expect(await state.settleAll()).toBe(1);
		// Nothing was written, and the other path can be inspected.
		await new Promise((resolve) => setTimeout(resolve, 700));
		await expect(stat(join(root, 'scratch.txt'))).rejects.toThrow();
		await state.open('renamed.txt');
		expect(state.sessionAt('renamed.txt')?.buffer).toBe('raw\n');
		// Only the person's choice ends it.
		state.discardDraft('scratch.txt');
		expect(state.sessionAt('scratch.txt')).toBeUndefined();
		await expect(stat(join(root, 'scratch.txt'))).rejects.toThrow();
		expect(await readFile(join(root, 'renamed.txt'), 'utf8')).toBe('raw\n');
	});

	test('a clean note whose unknown rename stopped being tracked stays held when its old path reads as missing', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		loseNext(folder.files, 'move', { landed: true });
		await state.rename(note.path, 'renamed.md');
		expect(state.stopTracking(note.path)).toBeUndefined();
		await state.refresh();
		expect(state.noteAt(note.path)).toBe(session);
		expect(session.dirty).toBe(false);
		expect(session.hold).toMatchObject({
			kind: 'detached',
			change: { kind: 'move', to: 'notes/renamed.md', state: 'unconfirmed' },
		});
		expect(session.state.observation.kind).toBe('missing');
		expect(session.unsettled).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 700));
		await expect(stat(join(root, note.path))).rejects.toThrow();
		// Saving at the old path is the person's explicit choice.
		expect(await session.saveNow()).toBeUndefined();
		expect(session.hold).toBeUndefined();
		expect(await readFile(join(root, note.path), 'utf8')).toContain('Hello');
		expect(await readFile(join(root, 'notes/renamed.md'), 'utf8')).toBe(
			note.text,
		);
	});

	test('a stuck rename can stop being tracked: the typing stays, both paths can be opened, and nothing is written', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		loseNext(folder.files, 'move', { landed: true });
		expect(await state.rename(note.path, 'renamed.md')).toContain(
			'not confirmed',
		);
		expect(typeBody(session, 'Typed while it was unknown\n')).toBe(true);
		// While it is tracked, the destination gets no editor and the draft
		// cannot be discarded.
		await state.open('notes/renamed.md');
		expect(state.noteAt('notes/renamed.md')).toBeUndefined();
		await state.open(note.path);
		state.discardDraft(note.path);
		expect(state.noteAt(note.path)).toBe(session);

		expect(state.stopTracking(note.path)).toBeUndefined();
		expect(session.pathChange).toBeUndefined();
		expect(session.hold?.kind).toBe('detached');
		expect(session.state.document.body).toBe('Typed while it was unknown\n');
		expect(session.unsettled).toBe(true);
		// The destination opens, as what is there, when it is opened again.
		await state.refresh();
		await state.open('notes/renamed.md');
		expect(state.noteAt('notes/renamed.md')?.state.document.body).toBe(
			'Hello\n',
		);
		// Nothing was saved by itself, at either path.
		await new Promise((resolve) => setTimeout(resolve, 700));
		await expect(stat(join(root, note.path))).rejects.toThrow();
		expect(await readFile(join(root, 'notes/renamed.md'), 'utf8')).toBe(
			note.text,
		);
		// The person discards the draft; nothing is written.
		state.discardDraft(note.path);
		expect(state.noteAt(note.path)).toBeUndefined();
		await expect(stat(join(root, note.path))).rejects.toThrow();
	});
});

describe('field actions and what they were derived from', () => {
	/** A note in a new folder `Work`, a second folder `Home`, and the note's text moved to `Home`. */
	async function filed() {
		const made = await product();
		const { state, root, seedNote } = made;
		const note = await seedNote();
		expect(await state.createFolder('Work')).toBeUndefined();
		expect(await state.createFolder('Home')).toBeUndefined();
		const work = state.folders.find((entry) => entry.fields.name === 'Work');
		const home = state.folders.find((entry) => entry.fields.name === 'Home');
		if (work === undefined || home === undefined)
			throw new Error('The folders are not listed');
		expect(
			await state.patchNote(note.path, { folderId: work.stem }),
		).toBeUndefined();
		const inWork = await readFile(join(root, note.path), 'utf8');
		const inHome = inWork.replace(
			/^folderId: .*$/m,
			`folderId: "${home.stem}"`,
		);
		expect(inHome).not.toBe(inWork);
		return { ...made, note, work, home, inWork, inHome };
	}

	test('deleting a folder does not undo a move another program made after the list was read', async () => {
		const { state, root, note, work, inHome } = await filed();
		// This folder hints at its own writes only, so the list still says Work.
		await writeFile(join(root, note.path), inHome);
		expect(await state.deleteFolder(work)).toContain(
			'changed after it was read',
		);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(inHome);
		expect(await readFile(join(root, work.path), 'utf8')).toContain('Work');
		expect(state.pending).toEqual([]);
		// Read again, Work holds nothing, and it goes.
		await state.refresh();
		expect(await state.deleteFolder(work)).toBeUndefined();
		await expect(stat(join(root, work.path))).rejects.toThrow();
		expect(await readFile(join(root, note.path), 'utf8')).toBe(inHome);
	});

	test('a lost move out of a folder being deleted is sent again only onto the bytes it was derived from', async () => {
		const { state, folder, root, note, work, inWork, inHome } = await filed();
		const listed = state.notes.find((entry) => entry.path === note.path);
		if (listed === undefined) throw new Error('The note is not listed');
		const land = loseNext(folder.tables.notes, 'update', { landed: false });
		expect(await state.deleteFolder(work)).toContain('not confirmed');
		const [change] = state.pending;
		expect(change).toMatchObject({
			kind: 'changeRow',
			path: note.path,
			fields: { folderId: null },
			options: { expectedSha256: listed.sha256 },
			state: 'unconfirmed',
		});
		if (change === undefined) throw new Error('Nothing is pending');
		expect(await readFile(join(root, work.path), 'utf8')).toContain('Work');
		// Nothing more is sent for that note while the record stands.
		expect(await state.deleteFolder(work)).toContain('not confirmed');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(inWork);
		// Another program moves the note. Asking again does not rebase onto it.
		await writeFile(join(root, note.path), inHome);
		expect(await state.retryPending(change)).toContain(
			'changed after it was read',
		);
		expect(state.pending).toEqual([change]);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(inHome);
		// The lost request arriving late is refused the same way.
		expect((await land()).error?.name).toBe('Conflict');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(inHome);
	});

	test('an open member is moved out only while its editor holds the bytes listed', async () => {
		const { state, root, note, work, inHome } = await filed();
		const session = await openedNote(state, note.path);
		await writeFile(join(root, note.path), inHome);
		// The clean editor follows the file; the list was read before it.
		await session.refresh();
		expect(session.state.document.fields.folderId).not.toBe(work.stem);
		expect(await state.deleteFolder(work)).toContain(
			'changed after it was read',
		);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(inHome);
		expect(await readFile(join(root, work.path), 'utf8')).toContain('Work');
		expect(session.dirty).toBe(false);
	});

	test('an open member with typing is moved out through its draft, typing included', async () => {
		const { state, root, note, work } = await filed();
		const session = await openedNote(state, note.path);
		typeBody(session, 'typed in the member\n');
		expect(await state.deleteFolder(work)).toBeUndefined();
		await expect(stat(join(root, work.path))).rejects.toThrow();
		const saved = inspectRow(
			honeycrispDefinition.tables.notes,
			await readFile(join(root, note.path), 'utf8'),
		);
		expect(saved.fields.folderId).toBeNull();
		expect(saved.body).toBe('typed in the member\n');
		expect(state.noteAt(note.path)).toBe(session);
	});

	test('an action on an open note whose file changed under its draft is refused before the draft changes', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		typeBody(session, 'my unsaved text\n');
		await writeFile(join(root, note.path), OUTSIDE);
		await state.refresh();
		expect(session.external?.kind).toBe('present');
		expect(await state.trashNote(note.path)).toContain('changed elsewhere');
		expect(await state.patchNote(note.path, { pinned: true })).toContain(
			'changed elsewhere',
		);
		expect(session.state.document.fields).toMatchObject({
			deletedAt: null,
			pinned: false,
		});
		expect(session.state.document.body).toBe('my unsaved text\n');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(OUTSIDE);
		// Typing into the draft is still the person's to do.
		expect(
			await state.patchNote(note.path, { title: 'Mine' }, { save: 'later' }),
		).toBeUndefined();
		expect(session.state.document.fields.title).toBe('Mine');
	});

	test('an action on an open note whose save got no reply is refused, and the save is not sent again', async () => {
		const { state, folder, handle, root, seedNote } = await product();
		const note = await seedNote();
		const lost = loseNextSave(
			folder,
			(path, source) => handle.files.overwrite(path, source),
			{ landed: false },
		);
		const session = await openedNote(state, note.path);
		typeBody(session, 'typed before the lost save\n');
		expect(await session.saveNow()).toBeDefined();
		expect(session.hold?.kind).toBe('unconfirmed');
		for (const act of [
			() => state.trashNote(note.path),
			() => state.patchNote(note.path, { pinned: true }),
		])
			expect(await act()).toContain('not settled');
		expect(lost.saves).toBe(1);
		expect(session.state.document.fields).toMatchObject({
			deletedAt: null,
			pinned: false,
		});
		expect(session.state.document.body).toBe('typed before the lost save\n');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(note.text);
	});

	test('an action while an open note has a save queued or running is refused, and a lost reply stays unknown', async () => {
		const { state, folder, handle, root, seedNote } = await product();
		const note = await seedNote();
		const reply = Promise.withResolvers<void>();
		const lost = loseNextSave(
			folder,
			(path, source) => handle.files.overwrite(path, source),
			{ landed: false, held: reply.promise },
		);
		const session = await openedNote(state, note.path);
		typeBody(session, 'typed\n');
		const saving = session.saveNow();
		// The same turn: the save is queued and has not reached the editor.
		const sameTurn = state.patchNote(note.path, { pinned: true });
		expect(session.state.saving).toBeUndefined();
		expect(await sameTurn).toContain('still running');
		await lost.asked;
		expect(await state.trashNote(note.path)).toContain('still running');
		reply.resolve();
		expect(await saving).toBeDefined();
		// No second save ended the unknown outcome, and no refused value is in the draft.
		expect(session.hold?.kind).toBe('unconfirmed');
		expect(lost.saves).toBe(1);
		expect(session.state.document.fields).toMatchObject({
			pinned: false,
			deletedAt: null,
		});
		expect(session.state.document.body).toBe('typed\n');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(note.text);
		// Input into the draft is still taken; it saves nothing by itself.
		expect(
			await state.patchNote(note.path, { title: 'Mine' }, { save: 'later' }),
		).toBeUndefined();
		expect(session.state.document.fields.title).toBe('Mine');
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(lost.saves).toBe(1);
	});

	test('a folder is not deleted while an open member has an unsaved draft in another folder', async () => {
		const { state, root, note, work, home, inWork } = await filed();
		const session = await openedNote(state, note.path);
		expect(
			await state.patchNote(
				note.path,
				{ folderId: home.stem },
				{ save: 'later' },
			),
		).toBeUndefined();
		expect(await state.deleteFolder(work)).toContain(
			'moves it to another folder',
		);
		expect(session.state.document.fields.folderId).toBe(home.stem);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(inWork);
		expect(await readFile(join(root, work.path), 'utf8')).toContain('Work');
	});

	test('a folder is not deleted while an open note outside it has an unsaved draft in it, and no member moves first', async () => {
		const { state, root, note, work, inWork, seedNote } = await filed();
		const other = await seedNote('Other');
		const session = await openedNote(state, other.path);
		expect(
			await state.patchNote(
				other.path,
				{ folderId: work.stem },
				{ save: 'later' },
			),
		).toBeUndefined();
		expect(await state.deleteFolder(work)).toContain('draft in this folder');
		expect(session.state.document.fields.folderId).toBe(work.stem);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(inWork);
		expect(await readFile(join(root, work.path), 'utf8')).toContain('Work');
	});

	test('a folder is not deleted while a note change that names it was not confirmed', async () => {
		const { state, folder, root, note, work, inWork, seedNote } = await filed();
		const other = await seedNote('Other');
		await state.refresh();
		loseNext(folder.tables.notes, 'update', { landed: false });
		expect(
			await state.patchNote(other.path, { folderId: work.stem }),
		).toContain('not confirmed');
		expect(await state.deleteFolder(work)).toContain('not confirmed');
		const [change] = state.pending;
		if (change === undefined) throw new Error('Nothing is pending');
		state.dismissPending(change);
		loseNext(folder.tables.notes, 'create', { landed: false });
		state.showFolder(work.stem);
		expect(await state.createNote()).toContain('not confirmed');
		expect(await state.deleteFolder(work)).toContain('New note');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(inWork);
		expect(await readFile(join(root, work.path), 'utf8')).toContain('Work');
	});

	test('a folder is not deleted while a change to any note is still running', async () => {
		const { state, folder, root, note, work, inWork, seedNote } = await filed();
		const other = await seedNote('Other');
		await state.refresh();
		const held = holdNext(folder.tables.notes, 'update');
		const pinning = state.patchNote(other.path, { pinned: true });
		await held.asked;
		expect(await state.deleteFolder(work)).toContain('still running');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(inWork);
		held.release();
		expect(await pinning).toBeUndefined();
		expect(await state.deleteFolder(work)).toBeUndefined();
		await expect(stat(join(root, work.path))).rejects.toThrow();
	});

	test('storage that throws while an open member is moved out keeps the folder and an unknown outcome', async () => {
		const { state, folder, root, note, work, inWork } = await filed();
		const edit = folder.tables.notes.edit;
		folder.tables.notes.edit = async (stem, options) => {
			const opened = await edit(stem, options);
			if (opened.error !== null) return opened;
			return Ok({
				...opened.data,
				save: async () => {
					throw new Error('storage broke');
				},
			});
		};
		const session = await openedNote(state, note.path);
		expect(await state.deleteFolder(work)).toContain('storage broke');
		// A throw says nothing about whether the bytes landed.
		expect(session.hold?.kind).toBe('unconfirmed');
		expect(session.status).toBe('unconfirmed');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(inWork);
		expect(await readFile(join(root, work.path), 'utf8')).toContain('Work');
	});

	test('a member save that lands before the read after it throws is not called failed, and the folder stays', async () => {
		const { state, folder, root, note, work } = await filed();
		const edit = folder.tables.notes.edit;
		folder.tables.notes.edit = async (stem, options) => {
			const opened = await edit(stem, options);
			if (opened.error !== null) return opened;
			const editor = opened.data;
			let saved = false;
			return Ok({
				...editor,
				async save() {
					const reply = await editor.save();
					saved = reply.error === null;
					return reply;
				},
				async refresh() {
					if (saved) {
						saved = false;
						throw new Error('read broke');
					}
					return editor.refresh();
				},
			});
		};
		const session = await openedNote(state, note.path);
		expect(await state.deleteFolder(work)).toContain('read broke');
		expect(session.hold?.kind).toBe('unconfirmed');
		// The save did land; the session does not claim either way.
		const saved = inspectRow(
			honeycrispDefinition.tables.notes,
			await readFile(join(root, note.path), 'utf8'),
		);
		expect(saved.fields.folderId).toBeNull();
		expect(await readFile(join(root, work.path), 'utf8')).toContain('Work');
	});

	test('a pending field change keeps the values asked for, whatever the caller does with its object', async () => {
		const { state, folder, root } = await product();
		expect(await state.createFolder('Before')).toBeUndefined();
		const [entry] = state.folders;
		if (entry === undefined) throw new Error('The folder is not listed');
		loseNext(folder.tables.folders, 'update', { landed: false });
		const fields = { name: 'Original request' };
		const asking = state.patchFolder(entry, fields);
		// Before the first send: the change has not reached the folder yet.
		fields.name = 'Mutated in the same turn';
		expect(await asking).toContain('not confirmed');
		fields.name = 'Mutated later';
		const [change] = state.pending;
		if (change?.kind !== 'changeRow') throw new Error('No change is pending');
		expect(change.fields).not.toBe(fields);
		expect(change.fields).toEqual({ name: 'Original request' });
		expect(Object.isFrozen(change.fields)).toBe(true);
		expect(Object.isFrozen(change)).toBe(true);
		expect(Object.isFrozen(fields)).toBe(false);
		expect(() => {
			(change.fields as { name: string }).name = 'Through the record';
		}).toThrow();
		expect(await state.retryPending(change)).toBeUndefined();
		expect(await readFile(join(root, entry.path), 'utf8')).toBe(
			'---\nname: Original request\nicon: null\n---\n',
		);
	});

	test('a folder delete reads the relation a pending change was asked with, not its caller object now', async () => {
		const { state, folder, root, note, work, inWork, seedNote } = await filed();
		const other = await seedNote('Other');
		await state.refresh();
		loseNext(folder.tables.notes, 'update', { landed: false });
		const fields: { folderId: string | null } = { folderId: work.stem };
		expect(await state.patchNote(other.path, fields)).toContain(
			'not confirmed',
		);
		fields.folderId = null;
		expect(await state.deleteFolder(work)).toContain('not confirmed');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(inWork);
		expect(await readFile(join(root, work.path), 'utf8')).toContain('Work');
	});

	test('a note put in the folder while its notes move out keeps the folder', async () => {
		const { state, folder, root, note, work, seedNote } = await filed();
		const other = await seedNote('Other');
		await state.refresh();
		const update = folder.tables.notes.update;
		folder.tables.notes.update = async (...args) => {
			folder.tables.notes.update = update;
			const text = await readFile(join(root, other.path), 'utf8');
			await writeFile(
				join(root, other.path),
				text.replace(/^folderId: .*$/m, `folderId: "${work.stem}"`),
			);
			return update(...args);
		};
		expect(await state.deleteFolder(work)).toContain('put in this folder');
		expect(await readFile(join(root, work.path), 'utf8')).toContain('Work');
		const folderOf = (path: string) =>
			state.notes.find((entry) => entry.path === path)?.fields.folderId;
		expect(folderOf(note.path)).toBeNull();
		expect(folderOf(other.path)).toBe(work.stem);
		// Asked again, the note that arrived moves out too.
		expect(await state.deleteFolder(work)).toBeUndefined();
		await expect(stat(join(root, work.path))).rejects.toThrow();
		expect(folderOf(other.path)).toBeNull();
	});

	test('a folder whose stem reads as a number is named as a string', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		await writeFile(
			join(root, 'folders', '1e5.md'),
			'---\nname: Numeric\nicon: null\n---\n',
		);
		await state.refresh();
		const numeric = state.folders.find((entry) => entry.stem === '1e5');
		if (numeric === undefined) throw new Error('The folder is not listed');
		expect(
			await state.patchNote(note.path, { folderId: '1e5' }),
		).toBeUndefined();
		expect(await readFile(join(root, note.path), 'utf8')).toBe(
			note.text.replace('folderId: null', 'folderId: "1e5"'),
		);
		expect(await state.deleteFolder(numeric)).toBeUndefined();
		expect(await readFile(join(root, note.path), 'utf8')).toBe(note.text);
	});
});

describe('one owner per path', () => {
	test('a note open as text owns its file: field changes are refused, and its typing is kept', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		expect(await state.createFolder('Work')).toBeUndefined();
		const [work] = state.folders;
		if (work === undefined) throw new Error('The folder is not listed');
		expect(
			await state.patchNote(note.path, { folderId: work.stem }),
		).toBeUndefined();
		await openedNote(state, note.path);
		expect(await state.editAsFile(note.path)).toBeUndefined();
		const raw = state.sessionAt(note.path);
		if (raw === undefined) throw new Error('The note did not open as text');
		const filed = await readFile(join(root, note.path), 'utf8');
		raw.input(raw.buffer.replace('Hello', 'Typed as text'));
		for (const ask of [
			() => state.patchNote(note.path, { pinned: true }),
			() => state.trashNote(note.path),
			() => state.restoreNote(note.path),
		])
			expect(await ask()).toContain('open as text');
		expect(await state.deleteFolder(work)).toContain('open as text');
		expect(await readFile(join(root, work.path), 'utf8')).toContain('Work');
		expect(raw.buffer).toContain('Typed as text');
		expect(state.sessionAt(note.path)).toBe(raw);
		expect(state.noteAt(note.path)).toBeUndefined();
		// The typing is the text session's to save.
		expect(await raw.settle()).toBe(true);
		// Exactly the text session's bytes: nothing else rewrote the file.
		const saved = await readFile(join(root, note.path), 'utf8');
		expect(saved).toBe(filed.replace('Hello', 'Typed as text'));
		expect(
			inspectRow(honeycrispDefinition.tables.notes, saved).fields,
		).toMatchObject({ folderId: work.stem, pinned: false });
	});

	test('opening as a note keeps the text when another program wrote the file before a hint arrived', async () => {
		const { state, root, seedRepair } = await product();
		const repair = await seedRepair();
		const raw = await openedFile(state, repair.path);
		raw.input(OUTSIDE.replace('title: Outside', 'title: Mine'));
		await raw.save();
		expect(raw.status).toBe('saved');
		// Another program writes; this folder does not hint at it.
		await writeFile(join(root, repair.path), OUTSIDE);
		expect(await state.openAsNote(repair.path)).toContain('changed while');
		expect(state.noteAt(repair.path)).toBeUndefined();
		expect(state.sessionAt(repair.path)).toBe(raw);
		expect(await readFile(join(root, repair.path), 'utf8')).toBe(OUTSIDE);
	});
});

describe('closing', () => {
	test('a note still opening when the page closes is abandoned: its editor is aborted or disposed, and nothing opens after', async () => {
		const { state, folder, seedNote } = await product();
		const note = await seedNote();
		await state.refresh();
		const edit = folder.tables.notes.edit;
		const answered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		let late: Awaited<ReturnType<typeof edit>> | undefined;
		folder.tables.notes.edit = async (stem, options) => {
			signal = options?.signal;
			// The folder answers before the close; the answer reaches the page after.
			late = await edit(stem);
			answered.resolve();
			await release.promise;
			return late;
		};
		const opening = state.open(note.path);
		await answered.promise;
		await state.close();
		expect(signal?.aborted).toBe(true);
		release.resolve();
		await opening;
		expect(late?.data?.get().isDisposed).toBe(true);
		expect(state.noteAt(note.path)).toBeUndefined();
		// Nothing opens after the close, and its fence is not released.
		folder.tables.notes.edit = edit;
		await state.open(note.path);
		expect(state.noteAt(note.path)).toBeUndefined();
		state.fenceInput()();
		expect(state.fenced).toBe(true);
	});

	test('a text file still being read when the page closes gets no session', async () => {
		const { state, folder } = await product();
		expectOk(await folder.files.create('scratch.txt', 'raw\n'));
		await state.refresh();
		const read = folder.files.read;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		folder.files.read = async (path) => {
			const result = await read(path);
			started.resolve();
			await release.promise;
			return result;
		};
		const opening = state.open('scratch.txt');
		await started.promise;
		await state.close();
		release.resolve();
		await opening;
		expect(state.sessionAt('scratch.txt')).toBeUndefined();
	});
});

test('a source handoff started before close cannot install a raw owner afterward', async () => {
	const { state, seedNote } = await product();
	const note = await seedNote();
	await openedNote(state, note.path);
	const changing = state.editAsFile(note.path);
	await state.close();
	expect(await changing).toBeDefined();
	expect(state.sessionAt(note.path)).toBeUndefined();
});
