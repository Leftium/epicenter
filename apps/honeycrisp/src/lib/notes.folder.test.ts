/**
 * Notes Over A Real Directory Tests
 *
 * Runs the notes state, its note sessions, and its raw file sessions against
 * a real temporary directory with automatic history disabled. Explicit
 * history checks use the real `git`. The folder is the folder package's
 * directory opener, with the same handle the desktop page receives from the
 * shell, and its own row editors, so these cover what Honeycrisp does with a
 * folder, not how the page reaches one. A note write that must wait or lose
 * its reply runs over the real browser folder instead (`browserProduct`),
 * whose storage stand-in takes those faults under the same row editor.
 *
 * Key behaviors:
 * - Reading or opening a note never rewrites it; a note's save writes the
 *   complete canonical document: unknown values stay, comments and spelling do not
 * - A Git failure is history, never a save error
 * - An open note keeps its text when another program writes, until the
 *   person reloads; its next save replaces the file (the last writer wins)
 * - A note whose text does not read as one opens its one editor and is
 *   repaired in its file view; no note is handed to a text session
 * - A path owns one session across selection, rename, and deletion; a rename
 *   or delete settles the note, fences its input, and acts on the file as
 *   captured after that
 * - A deleted note is never written back by a save; creating it again is the
 *   person's separate, exclusive choice
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
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	honeycrispDefinition,
	type NoteEntry,
	noteIdOf,
	repairReason,
} from './data.js';
import type { FileSession } from './file-session.svelte.js';
import { openNotesFolder } from './folder.test-support.js';
import type { NoteControl, NoteEditor } from './note-editor.svelte.js';
import { withBody } from './note-source.js';
import { setUpFolder } from './platform/first-open.js';
import type { NotesFolder, NotesHost } from './platform/types.js';
import { draftsLine } from './status.js';

const { createNotes } = await import('./notes.svelte.ts');
const { noteSaveProblem } = await import('./note-editor.svelte.ts');
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
	let drafts = 0;
	/** A text file that is not a note, so it opens as a raw session over its exact text. */
	const seedText = async () => {
		drafts += 1;
		const path = `docs/draft-${drafts}.md`;
		const source = '---\ntitle: [open\n---\nHello\n';
		expectOk(await handle.files.create(path, source));
		const sha256 = expectOk(await handle.files.read(path)).sha256;
		return { path, source, sha256 };
	};
	/** The note files in the folder now. */
	const notePaths = async () =>
		expectOk(await handle.tables.notes.list()).map((item) => item.path);
	/** The files in `docs` now. */
	const textPaths = async () =>
		expectOk(await handle.files.list())
			.files.map((file) => file.path)
			.filter((path) => path.startsWith('docs/'));
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
		seedText,
		notePaths,
		textPaths,
		ran,
		state,
	};
}

type State = Awaited<ReturnType<typeof product>>['state'];

/**
 * The notes state over Honeycrisp's real browser folder on the in-memory
 * OPFS stand-in, for a note write that must wait, fail, or lose its reply.
 * The production row editor writes through the stand-in's file streams,
 * which take those faults; nothing wraps the editor.
 */
async function browserProduct() {
	const fixture = await openNotesFolder();
	const state = createNotes(fixture.host);
	cleanup.push(() => state.close());
	const seedNote = async (title = 'First') => {
		const { stem } = expectOk(
			await fixture.folder.tables.notes.create({
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
		return expectOk(await fixture.folder.tables.notes.get(stem)) as NoteEntry;
	};
	await state.refreshAll();
	return { ...fixture, state, seedNote };
}

/** A file opened in the notes state as text, with its raw session. */
async function openedFile(state: State, path: string): Promise<FileSession> {
	await state.refresh();
	await state.open(path);
	const session = state.sessionAt(path);
	if (session === undefined) throw new Error(`${path} did not open as text`);
	return session;
}

/**
 * A note opened in the notes state, with its note session. Its editor read
 * the file when it opened and never reads it again by itself.
 */
async function openedNote(state: State, path: string): Promise<NoteEditor> {
	await state.refresh();
	await state.open(path);
	const session = state.noteAt(path);
	if (session === undefined) throw new Error(`${path} did not open as a note`);
	return session;
}

/** Replace a note's body as Source does. Whether it was taken. */
function typeBody(session: NoteEditor, body: string): boolean {
	const { row } = session;
	return (
		row.status === 'valid' &&
		session.set(withBody(row, body), { control: 'body' }) === undefined
	);
}

/** Put `fields` in a note as its controls do: the whole note, every other field kept. */
function setFields(
	session: NoteEditor,
	fields: Partial<NoteEntry['fields']>,
	options?: { control?: NoteControl },
): string | undefined {
	const { row } = session;
	if (row.status !== 'valid') return 'This note is not showing its fields.';
	return session.set({ ...row, fields: { ...row.fields, ...fields } }, options);
}

/** The structured note as its views show it. */
function shown(session: NoteEditor) {
	const { row } = session;
	if (row.status !== 'valid' || session.rawMode)
		throw new Error(`${session.path} does not show its fields`);
	return row;
}

/** The whole text the note's views show now. */
const textOf = (session: NoteEditor): string => session.row.text;

/** Wait for a note's admitted writes. Resolves why they did not end saved. */
async function saved(session: NoteEditor): Promise<string | undefined> {
	const { error } = await session.waitForSaves();
	return error === null ? undefined : noteSaveProblem(error);
}

/**
 * Another program deletes an open note's file, then the person types: the
 * save finds no file. Resolves the exact text the editor keeps.
 */
async function typedAfterDeletion(
	session: NoteEditor,
	root: string,
	body = 'Retained\n',
): Promise<string> {
	await rm(join(root, session.path));
	expect(typeBody(session, body)).toBe(true);
	expect(await saved(session)).toContain('not there');
	expect(session.missing).toBe(true);
	return textOf(session);
}

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
		expect(session.unsettled).toBe(false);
		expect(shown(session).fields.title).toBe('Spaced');
		expect(await saved(session)).toBeUndefined();
		expect(await state.settleAll()).toBe(0);
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
		expect(await saved(session)).toBeUndefined();
		const written = await readFile(file, 'utf8');
		const updatedAt = shown(session).fields.updatedAt;
		expect(updatedAt).not.toBe('2026-10-01T00:00:00.000Z');
		expect(written).toBe(
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
		expect(
			inspectRow(honeycrispDefinition.tables.notes, written).issues,
		).toEqual([]);
		// Listing the saved file again writes nothing.
		const before = await stat(file);
		await state.refresh();
		expect(session.status).toBe('saved');
		expect(session.unsettled).toBe(false);
		expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
	});

	test("a note's own save reaches the list through the folder's hint, with no refresh asked", async () => {
		const { state, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const listed = () => state.notes.find((entry) => entry.path === note.path);

		expect(setFields(session, { title: 'Saved here' })).toBeUndefined();
		expect(await saved(session)).toBeUndefined();
		await until(
			() => listed()?.fields.title === 'Saved here',
			'the list to show the save',
		);
		expect(listed()?.fields.title).toBe('Saved here');
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
	expect(await saved(session)).toBeUndefined();
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
	test('keeps the text editable and later typing saves again', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const notes = join(root, 'notes');
		spawnSync('chmod', ['a-w', notes]);
		cleanup.push(async () => {
			spawnSync('chmod', ['u+w', notes]);
		});
		typeBody(session, 'Not yet saved\n');
		expect(await saved(session)).toContain('Not saved');
		expect(session.status).toBe('failed');
		expect(state.notSaved).toBe(1);
		expect(shown(session).body).toBe('Not yet saved\n');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(note.text);
		// Once writing succeeds, later typing saves again.
		spawnSync('chmod', ['u+w', notes]);
		expect(typeBody(session, 'Still not saved\n')).toBe(true);

		expect(await saved(session)).toBeUndefined();
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
	test('an open note keeps its text when another program writes, and its next save replaces the file', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		typeBody(session, 'Mine\n');
		expect(await saved(session)).toBeUndefined();
		await writeFile(
			join(root, note.path),
			note.text.replace('Hello', 'Theirs'),
		);
		await state.refresh();
		// The listing shows their text; the open note shows its own.
		expect(state.notes.find((entry) => entry.path === note.path)?.body).toBe(
			'Theirs\n',
		);
		expect(shown(session).body).toBe('Mine\n');
		expect(session.status).toBe('saved');
		expect(await readFile(join(root, note.path), 'utf8')).toContain('Theirs');
		// The last writer wins.
		typeBody(session, 'Mine again\n');
		expect(await saved(session)).toBeUndefined();
		expect(await readFile(join(root, note.path), 'utf8')).toContain(
			'Mine again',
		);
	});

	test('reloading shows the file as another program left it, and writes nothing', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const newer = note.text.replace('Hello', 'C');
		await writeFile(join(root, note.path), newer);
		await state.refresh();
		expect(shown(session).body).toBe('Hello\n');
		const before = await stat(join(root, note.path));
		expect(await session.reload()).toBeUndefined();
		expect(shown(session).body).toBe('C\n');
		expect(session.status).toBe('saved');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(newer);
		expect((await stat(join(root, note.path))).mtimeMs).toBe(before.mtimeMs);
	});

	test('a malformed file is still a note to select, opens its one editor, saves while malformed, and is repaired there', async () => {
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

		// Text that does not read as a note opens the note's one editor, for repair.
		const session = await openedNote(state, 'notes/bad.md');
		expect(state.sessionAt('notes/bad.md')).toBeUndefined();
		expect(state.selection?.kind).toBe('note');
		expect(session.row).toMatchObject({ status: 'invalid', text: malformed });
		// A structured change is refused and writes nothing: there are no fields
		// to change, open or not.
		expect(await state.patchNote('notes/bad.md', { pinned: true })).toContain(
			'needs fixing',
		);
		expect(await state.patchNote('notes/plain.md', { pinned: true })).toContain(
			'needs repair',
		);
		expect(await readFile(join(root, 'notes/plain.md'), 'utf8')).toBe(
			'No frontmatter\n',
		);
		expect(await readFile(join(root, 'notes/bad.md'), 'utf8')).toBe(malformed);
		expect(session.showFile(false)).toContain('cannot be opened as a note yet');
		// Still malformed text saves as written, and stays selectable.
		const still = malformed.replace('body', 'more body');
		expect(session.setText(still)).toBeUndefined();
		expect(await saved(session)).toBeUndefined();
		expect(session.status).toBe('saved');
		expect(await readFile(join(root, 'notes/bad.md'), 'utf8')).toBe(still);
		await state.refresh();
		expect(listed('notes/bad.md')?.text).toBe(still);
		expect(listed('notes/bad.md')?.parseError).toBeDefined();

		const fixed = OUTSIDE.replace('title: Outside', 'title: Fixed');
		session.setText(fixed);
		expect(await saved(session)).toBeUndefined();
		// Repaired text is written exactly as typed, comments and spelling included.
		expect(await readFile(join(root, 'notes/bad.md'), 'utf8')).toBe(fixed);
		await state.refresh();
		const repaired = listed('notes/bad.md') as NoteEntry;
		expect(repaired.fields.title).toBe('Fixed');
		// The same editor shows its fields once the person asks.
		expect(session.rawMode).toBe(true);
		expect(session.showFile(false)).toBeUndefined();
		expect(state.noteAt('notes/bad.md')).toBe(session);
		expect(shown(session).fields.title).toBe('Fixed');

		// Bytes that are not text open nothing: no editor and no text session.
		await state.open('notes/binary.md');
		expect(state.selection).toMatchObject({
			kind: 'file',
			file: { kind: 'failed' },
		});
		expect(state.sessionAt('notes/binary.md')).toBeUndefined();
		expect(state.noteAt('notes/binary.md')).toBeUndefined();
	});

	test('a note can be edited as a file, for keys its controls do not show, and opened as a note again', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		typeBody(session, 'Typed\n');
		// The file view is the same editor, with its text: nothing is handed to
		// another session.
		expect(session.showFile(true)).toBeUndefined();
		expect(state.noteAt(note.path)).toBe(session);
		expect(state.sessionAt(note.path)).toBeUndefined();
		const whole = textOf(session);
		expect(whole).toContain('Typed');
		session.setText(whole.replace('---\nTyped', '"owner": "sam"\n---\nTyped'));
		expect(await saved(session)).toBeUndefined();
		expect(session.showFile(false)).toBeUndefined();
		expect(shown(session).fields.owner).toBe('sam');
		// A title change keeps the key the fields do not show, and the body.
		expect(setFields(session, { title: 'Again' })).toBeUndefined();
		expect(await saved(session)).toBeUndefined();
		const written = await readFile(join(root, note.path), 'utf8');
		expect(written).toContain('"title": "Again"');
		expect(written).toContain('"owner": "sam"');
		expect(written.endsWith('---\nTyped\n')).toBe(true);
		// The file view again shows exactly what was saved.
		expect(session.showFile(true)).toBeUndefined();
		expect(textOf(session)).toBe(written);
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

	test('renaming an edited note saves it, then an editor at the new name takes its text and its place', async () => {
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
		expect(shown(renamed).body).toBe('Edited before rename\n');
		expect(renamed.status).toBe('saved');
		// The old session takes nothing more.
		expect(session.released).toBe(true);
		expect(typeBody(session, 'Late\n')).toBe(false);
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

	test('a rename takes no input while it runs, writes nothing to either path, and the editor at the new name takes over', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const move = holdNext(folder.files, 'move');
		const renaming = state.rename(note.path, 'renamed.md');
		await move.asked;
		expect(session.status).toBe('saving');
		expect(session.admitting).toBe(false);
		expect(typeBody(session, 'Typed during the rename\n')).toBe(false);
		expect(session.retry()).toContain('rename or delete');
		expect(await session.reload()).toContain('rename or delete');
		expect(await readFile(join(root, note.path), 'utf8')).toBe(note.text);
		move.release();
		expect(await renaming).toBeUndefined();
		const renamed = state.noteAt('notes/renamed.md');
		if (renamed === undefined) throw new Error('No note at the new name');
		expect(shown(renamed).body).toBe('Hello\n');
		// The old editor publishes nothing more at the old path.
		expect(typeBody(session, 'Late\n')).toBe(false);
		expect(typeBody(renamed, 'Typed after the rename\n')).toBe(true);
		expect(await saved(renamed)).toBeUndefined();
		expect(await readFile(join(root, 'notes/renamed.md'), 'utf8')).toContain(
			'Typed after the rename',
		);
		await expect(stat(join(root, note.path))).rejects.toThrow();
	});

	test('input in the same turn a rename or delete is asked for is refused, and the person’s later choice works', async () => {
		const { state, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const renaming = state.rename(note.path, 'renamed.md');
		// No await yet: the fence is already up.
		expect(session.admitting).toBe(false);
		expect(setFields(session, { title: 'Same turn' })).toContain(
			'rename or delete',
		);
		expect(typeBody(session, 'Same turn\n')).toBe(false);
		expect(await renaming).toBeUndefined();
		const renamed = state.noteAt('notes/renamed.md');
		if (renamed === undefined) throw new Error('No note at the new name');
		expect(shown(renamed).fields.title).toBe('First');
		expect(setFields(renamed, { title: 'Later' })).toBeUndefined();

		const deletion = expectOk(await state.deletionFor('notes/renamed.md'));
		const removing = state.remove(deletion);
		expect(setFields(renamed, { title: 'Same turn' })).toContain(
			'rename or delete',
		);
		expect(await removing).toBeUndefined();
		expect(state.noteAt('notes/renamed.md')).toBeUndefined();
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
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		typeBody(session, 'Saved before deleting\n');
		const deletion = expectOk(await state.deletionFor(note.path));
		// The capture is read after the save settled: the bytes the person is shown.
		expect(deletion).toEqual({
			kind: 'file',
			file: {
				path: note.path,
				sha256: expectOk(await folder.files.read(note.path)).sha256,
			},
			title: 'First',
		});
		expect(session.unsettled).toBe(false);
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
		expect(state.noteAt(shown.path)).toBe(session);
		expect(session.pathChange).toBeUndefined();
		// The open note keeps its text until the person reloads.
		expect(textOf(session)).toBe(shown.text);
		expect(await session.reload()).toBeUndefined();
		expect(session.row).toMatchObject({
			body: 'Written by another program\n',
		});
		expect(state.pending).toEqual([]);
	});

	test('a raw file renamed into a note becomes a note: its one editor opens there and repairs it', async () => {
		const { state, folder, root } = await product();
		const source =
			'---\ntitle: Before\n# keep this comment\nunknown: "keep"\n---\nBody\n';
		expectOk(await folder.files.create('notes/raw.txt', source));
		const session = await openedFile(state, 'notes/raw.txt');
		expect(await state.rename('notes/raw.txt', 'raw.md')).toBeUndefined();
		// The settled text session is let go; the note's row editor owns the path.
		expect(state.sessionAt('notes/raw.md')).toBeUndefined();
		expect(state.sessionAt('notes/raw.txt')).toBeUndefined();
		const note = state.noteAt('notes/raw.md');
		if (note === undefined) throw new Error('The note did not open');
		expect(session.path).toBe('notes/raw.md');
		expect(state.selection?.kind).toBe('note');
		expect(state.isNote('notes/raw.md')).toBe(true);
		// Its fields need values first, so no structured change is made.
		expect(note.row).toMatchObject({ status: 'invalid', text: source });
		expect(await state.patchNote('notes/raw.md', { title: 'After' })).toContain(
			'needs fixing',
		);
		note.setText(
			OUTSIDE.replace(
				'title: Outside',
				'# keep this comment\nunknown: "keep"\ntitle: Before',
			),
		);
		expect(await saved(note)).toBeUndefined();
		expect(note.showFile(false)).toBeUndefined();
		expect(
			await state.patchNote('notes/raw.md', { title: 'After' }),
		).toBeUndefined();
		const written = await readFile(join(root, 'notes/raw.md'), 'utf8');
		expect(written).toContain('"title": "After"');
		expect(written).toContain('"unknown": "keep"');
		expect(written).not.toContain('# keep this comment');
	});

	test('a note whose file turned malformed elsewhere keeps its text, refuses a rename, and reloads into the same editor for repair', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		typeBody(session, 'my text\n');
		expect(await saved(session)).toBeUndefined();
		const broken = '---\ntitle: [broken\n---\noutside\n';
		await writeFile(join(root, note.path), broken);
		await state.refresh();
		expect(state.noteAt(note.path)).toBe(session);
		expect(shown(session).body).toBe('my text\n');
		expect(session.status).toBe('saved');
		// The rename reads the file first and finds other text than the note's.
		expect(await state.rename(note.path, 'renamed.md')).toContain(
			'Reload the file',
		);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(broken);
		expect(state.noteAt(note.path)).toBe(session);
		// Reloading shows the file to repair, in the same editor.
		expect(await session.reload()).toBeUndefined();
		expect(state.noteAt(note.path)).toBe(session);
		expect(state.sessionAt(note.path)).toBeUndefined();
		expect(session.row).toMatchObject({ status: 'invalid', text: broken });
		expect(state.selection?.kind).toBe('note');
	});

	test('restoring an open note that is not deleted saves it again, in its canonical form', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const hand = [
			'---',
			'# by hand',
			"title: 'First'",
			'owner: sam',
			'folderId: null',
			'pinned: false',
			'createdAt: "2026-10-01T00:00:00.000Z"',
			'updatedAt: "2026-10-01T00:00:00.000Z"',
			'deletedAt: null',
			'---',
			'Hello',
			'',
		].join('\n');
		await writeFile(join(root, note.path), hand);
		const session = await openedNote(state, note.path);
		expect(textOf(session)).toBe(hand);
		expect(await state.restoreNote(note.path)).toBeUndefined();
		const saved = await readFile(join(root, note.path), 'utf8');
		expect(saved).toBe(textOf(session));
		expect(saved).not.toContain('# by hand');
		expect(saved).toContain('"owner": "sam"');
		expect(saved).toContain('"updatedAt": "2026-10-01T00:00:00.000Z"');
	});

	test('a version put in an open note brings its fields, body, and time, and keeps keys it lacks', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		await writeFile(
			join(root, note.path),
			note.text.replace('---\n', '---\nowner: sam\n'),
		);
		const session = await openedNote(state, note.path);
		const version = [
			'---',
			'title: Old',
			'folderId: null',
			'pinned: true',
			'createdAt: "2026-10-01T00:00:00.000Z"',
			'updatedAt: "2026-09-01T00:00:00.000Z"',
			'deletedAt: null',
			'---',
			'Old body',
			'',
		].join('\n');
		expect(state.useVersion(session, version)).toBeUndefined();
		expect(await saved(session)).toBeUndefined();
		expect(shown(session)).toMatchObject({
			fields: {
				title: 'Old',
				pinned: true,
				owner: 'sam',
				updatedAt: '2026-09-01T00:00:00.000Z',
			},
			body: 'Old body\n',
		});
		expect(await readFile(join(root, note.path), 'utf8')).toBe(textOf(session));
	});

	test('typed text waiting in a control lets list actions and versions change other fields, never its own', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		expect(
			setFields(session, { title: 'Half \uD800' }, { control: 'title' }),
		).toContain('lone surrogate');
		expect(typeBody(session, 'Half \uD800\n')).toBe(false);
		expect(await state.patchNote(note.path, { pinned: true })).toBeUndefined();
		expect(await readFile(join(root, note.path), 'utf8')).toContain(
			'"pinned": true',
		);
		const version = (title: string, body: string) =>
			[
				'---',
				`title: ${title}`,
				'folderId: null',
				'pinned: false',
				'createdAt: "2026-10-01T00:00:00.000Z"',
				'updatedAt: "2026-09-01T00:00:00.000Z"',
				'deletedAt: null',
				'---',
				body,
			].join('\n');
		expect(state.useVersion(session, version('Other', 'Hello\n'))).toContain(
			'the title',
		);
		expect(state.useVersion(session, version('First', 'Other\n'))).toContain(
			'the Markdown source',
		);
		// A version with the waiting fields as the editor holds them is taken,
		// and the typed text stays where it was typed.
		expect(
			state.useVersion(session, version('First', 'Hello\n')),
		).toBeUndefined();
		expect(shown(session).fields).toMatchObject({
			pinned: false,
			updatedAt: '2026-09-01T00:00:00.000Z',
		});
		expect(session.refused.title?.value).toBe('Half \uD800');
		expect(session.refused.body?.value).toBe('Half \uD800\n');
		expect(await saved(session)).toBeUndefined();
	});

	test('metadata changes share the open session: a typed field and a list action each save at once', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		// What the title control does.
		expect(setFields(session, { title: 'Typed title' })).toBeUndefined();
		expect(shown(session).fields.title).toBe('Typed title');
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
			'definition.json',
			'kv.json',
		]);
	});

	test('a deleted note keeps its text editable, nothing writes it back, and the person can create it again at its own path', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		await rm(join(root, note.path));
		typeBody(session, 'Retained\n');
		expect(await saved(session)).toContain('not there');
		await state.refresh();
		// The listing no longer shows it; the open note keeps its editor.
		expect(state.noteAt(note.path)).toBe(session);
		expect(session.missing).toBe(true);
		expect(session.status).toBe('failed');
		expect(typeBody(session, 'Retained more\n')).toBe(true);
		const typed = textOf(session);
		// Try again does not create the file either.
		expect(session.retry()).toBeUndefined();
		expect(await saved(session)).toContain('not there');
		await expect(stat(join(root, note.path))).rejects.toThrow();
		// Creating it again is the person's separate choice, and only while the path is free.
		expect(await state.recoverDraft(note.path)).toBeUndefined();
		expect(await readFile(join(root, note.path), 'utf8')).toEqual(typed);
		const again = state.noteAt(note.path);
		if (again === undefined) throw new Error('The note did not open again');
		expect(again).not.toBe(session);
		expect(session.released).toBe(true);
		expect(shown(again).body).toBe('Retained more\n');
		expect(again.status).toBe('saved');
	});

	test('a deleted note whose path another program filled is saved as a new note, exactly, and that file stays', async () => {
		const { state, root, seedNote, notePaths } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const view = state.selection?.kind === 'note' && state.selection.key;
		expect(session.showFile(true)).toBeUndefined();
		// Comments, quoting, and an unknown key: the text is kept as typed.
		const typed = `${textOf(session).replace('---\n', "---\n# mine\nowner: 'sam'\n")}More\n`;
		await rm(join(root, note.path));
		expect(session.setText(typed)).toBeUndefined();
		expect(await saved(session)).toContain('not there');
		await state.refresh();
		await writeFile(join(root, note.path), OUTSIDE);
		expect(await state.recoverDraft(note.path)).toBeUndefined();
		// The file another program put there is untouched.
		expect(await readFile(join(root, note.path), 'utf8')).toBe(OUTSIDE);
		const created = (await notePaths()).filter((path) => path !== note.path);
		expect(created).toHaveLength(1);
		const [at] = created;
		if (at === undefined) throw new Error('No new note');
		expect(await readFile(join(root, at), 'utf8')).toBe(typed);
		// The view moves to the new note; the old session takes nothing more.
		expect(state.selectedPath).toBe(at);
		expect(state.selection?.kind === 'note' && state.selection.key).toBe(view);
		expect(state.noteAt(at)?.row.text).toBe(typed);
		expect(session.released).toBe(true);
		expect(state.noteAt(note.path)).toBeUndefined();
	});

	test('a new note whose create got no reply stays pending, and no second copy of the text is made', async () => {
		const { state, folder, root, seedNote, notePaths } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const typed = await typedAfterDeletion(session, root);
		await state.refresh();
		await writeFile(join(root, note.path), OUTSIDE);
		const create = folder.files.create;
		const asked: string[] = [];
		folder.files.create = async (path, content) => {
			asked.push(path);
			// The note's own path answers for itself; a new one loses its reply.
			if (path === note.path) return create(path, content);
			return FileError.Unconfirmed({
				path,
				operation: 'publishing to',
				cause: new Error('the reply was lost'),
			});
		};
		expect(await state.recoverDraft(note.path)).toContain('not confirmed');
		expect(asked).toHaveLength(2);
		expect(state.pending).toMatchObject([{ kind: 'create', source: typed }]);
		// Asking again sends nothing anywhere: that copy may still land.
		expect(await state.recoverDraft(note.path)).toContain('not confirmed');
		expect(asked).toHaveLength(2);
		expect(await notePaths()).toEqual([note.path]);
		expect(textOf(session)).toBe(typed);
		expect(state.noteAt(note.path)).toBe(session);
	});

	test('a note whose own save back got no reply keeps that path pending and keeps its text', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const typed = await typedAfterDeletion(session, root);
		await state.refresh();
		loseNext(folder.files, 'create', { landed: false });
		expect(await state.recoverDraft(note.path)).toContain('not confirmed');
		expect(state.pending).toMatchObject([{ kind: 'create', path: note.path }]);
		// Nothing else is changed at that path while the record stands.
		expect(await state.patchNote(note.path, { pinned: true })).toContain(
			'not confirmed',
		);
		expect(state.noteAt(note.path)).toBe(session);
		expect(session.released).toBe(false);
		expect(textOf(session)).toBe(typed);
	});

	test('a deleted note with a refused title waiting in its field is not saved as a file until the title is fixed', async () => {
		const { state, root, seedNote, notePaths } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		await typedAfterDeletion(session, root);
		// What the title control does with half of an emoji.
		expect(
			setFields(session, { title: 'Half \uD800' }, { control: 'title' }),
		).toContain('lone surrogate');
		const accepted = textOf(session);
		expect(await state.recoverDraft(note.path)).toContain('not saved yet');
		// Nothing was created, and the same session keeps the refused title.
		expect(await notePaths()).toEqual([]);
		expect(state.pending).toEqual([]);
		expect(state.noteAt(note.path)).toBe(session);
		expect(session.released).toBe(false);
		expect(session.refused.title?.value).toBe('Half \uD800');
		expect(textOf(session)).toBe(accepted);
		// Once the title is fixed in its control, the note is saved as a file.
		expect(
			setFields(session, { title: 'Half' }, { control: 'title' }),
		).toBeUndefined();
		expect(session.refused.title).toBeUndefined();
		// The corrected title starts a replace; it still cannot create the missing file.
		expect(await saved(session)).toContain('not there');
		expect(await state.recoverDraft(note.path)).toBeUndefined();
		expect(await readFile(join(root, note.path), 'utf8')).toContain(
			'"title": "Half"',
		);
		expect(session.released).toBe(true);
		expect(state.noteAt(note.path)?.row).toMatchObject({
			fields: { title: 'Half' },
		});
	});

	test('a note whose text has an unpaired surrogate is never created as a file, and its exact text stays', async () => {
		const { state, root, seedNote, notePaths } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		session.showFile(true);
		const typed = `${textOf(session)}half \uD800\n`;
		session.setText(typed);
		await session.waitForSaves();
		expect(session.save).toMatchObject({
			status: 'failed',
			error: { name: 'Unencodable' },
		});
		await rm(join(root, note.path));
		// The person's reload finds no file and keeps the text.
		expect(await session.reload()).toContain('not in the folder');
		expect(session.missing).toBe(true);
		expect(await state.recoverDraft(note.path)).toContain('unpaired surrogate');
		expect(await notePaths()).toEqual([]);
		expect(state.pending).toEqual([]);
		// Exactly what was typed, not the replacement character a write would make.
		expect(textOf(session)).toBe(typed);
	});

	test('a note created again that then does not open keeps the person’s exact text, counted at close, until it opens', async () => {
		for (const outside of ['replaced', 'removed'] as const) {
			const { state, folder, root, seedNote } = await product();
			const note = await seedNote();
			const session = await openedNote(state, note.path);
			const typed = await typedAfterDeletion(session, root);
			await state.refresh();
			const create = folder.files.create;
			folder.files.create = async (path, content) => {
				const created = await create(path, content);
				// Another program acts between the create and the editor's read.
				if (outside === 'replaced')
					await writeFile(join(root, path), new Uint8Array([0xff, 0xfe]));
				else await rm(join(root, path));
				return created;
			};
			const problem = await state.recoverDraft(note.path);
			expect(problem).toContain('could not be opened');
			expect(session.released).toBe(true);
			expect(state.selection).toMatchObject({
				kind: 'file',
				path: note.path,
				file: { kind: 'unopened', text: typed },
			});
			expect(state.unsettled).toBe(1);
			// A listing that fails, or no longer shows the file, drops nothing.
			const list = folder.tables.notes.list;
			folder.tables.notes.list = async () => {
				throw new Error('the listing failed');
			};
			await state.refresh();
			folder.tables.notes.list = list;
			await state.refresh();
			expect(state.selection).toMatchObject({
				file: { kind: 'unopened', text: typed },
			});
			// Once the file reads again, the note opens over it.
			await writeFile(join(root, note.path), typed);
			expect(await state.reopen(note.path)).toBeUndefined();
			expect(state.noteAt(note.path)?.row.text).toBe(typed);
			expect(state.unsettled).toBe(0);
		}
	});

	/**
	 * A note whose file was deleted and whose path another program filled,
	 * being saved as a new note, with the editor's read of that new note held
	 * after the create was confirmed.
	 */
	async function heldHandOff() {
		const made = await product();
		const { state, folder, root, seedNote } = made;
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const typed = await typedAfterDeletion(session, root);
		await state.refresh();
		await writeFile(join(root, note.path), OUTSIDE);
		const edit = folder.tables.notes.edit;
		const asked = Promise.withResolvers<string>();
		const release = Promise.withResolvers<void>();
		folder.tables.notes.edit = async (stem, options) => {
			folder.tables.notes.edit = edit;
			asked.resolve(stem);
			await release.promise;
			return edit(stem, options);
		};
		const recovering = state.recoverDraft(note.path);
		return {
			...made,
			note,
			session,
			typed,
			recovering,
			/** The new note's path, once its editor was asked for. */
			at: asked.promise.then((stem) => `notes/${stem}.md`),
			release: () => release.resolve(),
		};
	}

	test('saving a note as a new one fences its input and owns both paths until the new note opens', async () => {
		const {
			state,
			root,
			note,
			session,
			typed,
			recovering,
			at,
			release,
			notePaths,
		} = await heldHandOff();
		// The fence is up in the same turn, and stays up through the handoff.
		expect(session.admitting).toBe(false);
		const destination = await at;
		expect(await readFile(join(root, destination), 'utf8')).toBe(typed);
		expect(setFields(session, { title: 'Late' })).toContain('rename or delete');
		expect(typeBody(session, 'Typed while it opens\n')).toBe(false);
		// Neither asking again nor reloading nor opening the new note races it.
		expect(await state.recoverDraft(note.path)).toContain('still running');
		expect(await session.reload()).toContain('rename or delete');
		await state.open(destination);
		expect(state.noteAt(destination)).toBeUndefined();
		expect(state.selection).toMatchObject({
			kind: 'file',
			file: { kind: 'failed' },
		});
		expect(await notePaths()).toHaveLength(2);
		release();
		expect(await recovering).toBeUndefined();
		// One owner at the new note, holding exactly what was typed; one file made.
		const opened = state.noteAt(destination);
		expect(opened?.row.text).toBe(typed);
		expect(opened?.released).toBe(false);
		expect(session.released).toBe(true);
		expect(state.noteAt(note.path)).toBeUndefined();
		expect(await notePaths()).toHaveLength(2);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(OUTSIDE);
	});

	test('a close while a new note’s editor is being opened waits for it and installs nothing', async () => {
		const { state, root, note, session, typed, recovering, at, release } =
			await heldHandOff();
		const destination = await at;
		let closed = false;
		const closing = state.close().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(closed).toBe(false);
		release();
		await closing;
		await recovering;
		expect(state.noteAt(destination)).toBeUndefined();
		expect(state.noteAt(note.path)).toBe(session);
		expect(session.released).toBe(true);
		// The confirmed copy is in its file.
		expect(await readFile(join(root, destination), 'utf8')).toBe(typed);
	});

	test('a close waits for a note being created again, and installs no editor after it', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const typed = await typedAfterDeletion(session, root);
		await state.refresh();
		const held = holdNext(folder.files, 'create');
		const recovering = state.recoverDraft(note.path);
		await held.asked;
		let closed = false;
		const closing = state.close().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(closed).toBe(false);
		held.release();
		await closing;
		await recovering;
		expect(await readFile(join(root, note.path), 'utf8')).toBe(typed);
		// The close released the session it found; no new editor replaced it.
		expect(state.noteAt(note.path)).toBe(session);
		expect(session.released).toBe(true);
	});

	test('renaming a note also refuses a destination whose deleted note is still open', async () => {
		const { state, root, seedNote } = await product();
		const a = await seedNote('A');
		const b = await seedNote('B');
		const aSession = await openedNote(state, a.path);
		const bSession = await openedNote(state, b.path);
		await typedAfterDeletion(bSession, root, 'Retained B\n');
		await state.refresh();
		expect(await state.rename(a.path, `${b.stem}.md`)).toContain('draft');
		expect(state.noteAt(a.path)).toBe(aSession);
		expect(state.noteAt(b.path)).toBe(bSession);
		expect(textOf(bSession)).toContain('Retained B');
		expect(await readFile(join(root, a.path), 'utf8')).toBe(a.text);
		await expect(stat(join(root, b.path))).rejects.toThrow();
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
		expect(session.retry()).toContain('closing');
		expect(session.showFile(true)).toContain('closing');
		expect(await session.reload()).toContain('closing');
		expect(await state.discardDraft(note.path)).toContain('closing');
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
				file: { path: note.path, sha256: note.sha256 },
				title: undefined,
			}),
		).toContain('closing');
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
		expect(session.unsettled).toBe(false);
		// Nothing reads the file after the outside write, so the editor still
		// holds the note as created.
		await writeFile(join(root, note.path), OUTSIDE);
		expect(await state.rename(note.path, 'renamed.md')).toContain(
			'Reload the file',
		);
		expect(await notePaths()).toEqual([note.path]);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(OUTSIDE);
		expect(shown(session).body).toBe('Hello\n');
		expect(state.noteAt(note.path)).toBe(session);
		expect(await session.reload()).toBeUndefined();
		expect(shown(session).body).toBe('Written by another program\n');
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
 * A dirty draft of a text file whose file was deleted outside, ready to be
 * written back. `afterCreate` runs once that exclusive creation has landed
 * and before its reply reaches the session.
 */
async function removedRepairDraft({
	afterCreate = () => {},
}: {
	afterCreate?: (at: {
		session: FileSession;
		file: string;
	}) => void | Promise<void>;
} = {}) {
	const fixture = await product();
	const { state, folder, root, seedText } = fixture;
	const repair = await seedText();
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

	test('a draft whose path another program filled stays a draft, in conflict with that file', async () => {
		const { state, session, path, file, admitted, created, textPaths } =
			await removedRepairDraft();
		await writeFile(file, OUTSIDE);
		expect(await state.recoverDraft(path)).toContain('The file changed');
		expect(created).toEqual([]);
		expect(state.sessionAt(path)).toBe(session);
		expect(session.buffer).toBe(admitted);
		expect(session.external).toMatchObject({ current: { text: OUTSIDE } });
		expect(await readFile(file, 'utf8')).toBe(OUTSIDE);
		expect(await textPaths()).toEqual([path]);
	});

	test('a write back that landed with its reply lost is the file’s content, stays not confirmed, and saving again makes no second file', async () => {
		const { state, folder, session, path, file, admitted, textPaths } =
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
		expect(await textPaths()).toEqual([path]);
	});

	test('a write back not yet in the folder stays unconfirmed, and saving again sends what is on screen to the same path', async () => {
		const { state, folder, session, path, file, admitted, textPaths } =
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
		expect(expectErr(await land()).name).toBe('Exists');
		expect(await readFile(file, 'utf8')).toBe(b);
		expect(await textPaths()).toEqual([path]);
	});

	test('a first creation that lands between two presses does not leave the draft in two files, and stays not confirmed', async () => {
		const { state, folder, session, path, file, admitted, textPaths } =
			await removedRepairDraft();
		const land = loseNext(folder.files, 'create', { landed: false });
		await state.recoverDraft(path);
		await expect(stat(file)).rejects.toThrow();
		expectOk(await land());
		expect(await readFile(file, 'utf8')).toBe(admitted);
		const b = `${admitted}B\n`;
		session.input(b);
		// The occupant is the earlier text: no second file is made, and the
		// earlier save is still not known to be the one that put it there.
		expect(await state.recoverDraft(path)).toContain('not confirmed');
		expect(session.path).toBe(path);
		expect(session.attempt).toMatchObject({
			source: admitted,
			state: 'unconfirmed',
		});
		expect(session.saved.text).toBe(admitted);
		expect(session.buffer).toBe(b);
		expect(await textPaths()).toEqual([path]);
		// Nothing more is sent by itself.
		expect(await session.settle()).toBe(false);
		expect(await readFile(file, 'utf8')).toBe(admitted);
		// The person saves again, over what the file holds.
		expect(await state.recoverDraft(path)).toBeUndefined();
		expect(await readFile(file, 'utf8')).toBe(b);
		expect(await textPaths()).toEqual([path]);
	});

	test('other text at the path while a write back is unconfirmed is shown beside it, and no second file is made', async () => {
		const { state, folder, session, path, file, admitted, textPaths } =
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
		expect(await textPaths()).toEqual([path]);
		// The first creation cannot land while the path is not empty.
		expect(expectErr(await land()).name).toBe('Exists');
		expect(await readFile(file, 'utf8')).toBe(OUTSIDE);
	});
});

// ============================================================================
// A raw save whose reply is lost
// ============================================================================

describe('a raw save whose reply is lost', () => {
	/**
	 * A text draft whose save of `a` gets no reply. With `landed`, the file
	 * was written first. Without it the file is unchanged until `land()` runs
	 * that same conditional replace.
	 */
	async function unconfirmedSave({ landed }: { landed: boolean }) {
		const fixture = await product();
		const { state, folder, root, seedText } = fixture;
		const note = await seedText();
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
		const { state, folder, root, seedText } = await product();
		const note = await seedText();
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
		expect(expectErr(await land()).name).toBe('Conflict');
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
		expect(expectErr(await land()).name).toBe('Conflict');
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
		// The rename is not concluded, so nothing is typed or saved at the old
		// path, and nothing else is done to either path.
		expect(typeBody(session, 'typed after the rename\n')).toBe(false);
		expect(await state.settleAll()).toBe(1);
		expect(session.retry()).toContain('not finished');
		expect(await state.rename(note.path, 'other.md')).toBe(
			'Save or discard the open edits first.',
		);
		expect((await state.deletionFor(note.path)).error).toBe(
			'Save or discard the open edits first.',
		);
		expect(await session.reload()).toContain('Stop tracking');
		expect(state.noteAt(note.path)).toBe(session);
		expect(await readFile(join(root, 'notes/renamed.md'), 'utf8')).toBe(
			note.text,
		);
		expect(await notePaths()).toEqual(['notes/renamed.md']);
	});

	test('a rename whose reply is lost before it lands takes no typing at the old path, so nothing publishes there', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const land = loseNext(folder.files, 'move', { landed: false });
		expect(await state.rename(note.path, 'renamed.md')).toContain(
			'not confirmed',
		);
		expect(typeBody(session, 'typed after the rename\n')).toBe(false);
		expect(await saved(session)).toBeUndefined();
		expect(await readFile(join(root, note.path), 'utf8')).toBe(note.text);
		expect(shown(session).body).toBe('Hello\n');
		// The one move that was sent still lands on the bytes it named.
		expectOk(await land());
		await expect(stat(join(root, note.path))).rejects.toThrow();
		expect(await readFile(join(root, 'notes/renamed.md'), 'utf8')).toBe(
			note.text,
		);
	});

	test('a delete keeps the session and its text, and changes nothing more, whether or not the file is gone', async () => {
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
			// Typing would publish at a path whose file is not known: none is taken.
			expect(typeBody(session, 'typed after\n')).toBe(false);
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
		expect(expectErr(await land()).name).toBe('Exists');
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
		expect(shown(session).fields.pinned).toBe(true);
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

test('a deleted note created again with its reply lost stays pending, keeps the person’s text, and blocks a second creation', async () => {
	const { state, folder, root, seedNote } = await product();
	const note = await seedNote();
	const session = await openedNote(state, note.path);
	const typed = await typedAfterDeletion(session, root, 'Recovery typing\n');
	await state.refresh();
	loseNext(folder.files, 'create', { landed: true });
	expect(await state.recoverDraft(note.path)).toContain('not confirmed');
	// The text landed; which request put it there is not known.
	expect(await readFile(join(root, note.path), 'utf8')).toEqual(typed);
	expect(state.pending).toMatchObject([
		{ kind: 'create', path: note.path, source: typed },
	]);
	expect(state.noteAt(note.path)).toBe(session);
	expect(textOf(session)).toBe(typed);
	expect(await state.recoverDraft(note.path)).toContain('not confirmed');
	expect(state.pending).toHaveLength(1);
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
	expect(session.save.status).toBe('saving');
	const closing = state.close();
	expect(typeBody(session, 'Typed during the close\n')).toBe(false);
	await closing;
	expect(session.released).toBe(true);
	expect(await readFile(join(root, note.path), 'utf8')).toContain(
		'Typed before the close',
	);
});

// ============================================================================
// Holds, ownership, and closing
// ============================================================================

describe('what a note session holds until the person chooses', () => {
	test('a failed save stays failed when another program writes the same text, until the person reloads', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const notes = join(root, 'notes');
		spawnSync('chmod', ['a-w', notes]);
		cleanup.push(async () => {
			spawnSync('chmod', ['u+w', notes]);
		});
		typeBody(session, 'Mine\n');
		expect(await saved(session)).toContain('Not saved');
		expect(session.status).toBe('failed');
		// Another program writes exactly the text the editor holds, in place.
		const text = textOf(session);
		spawnSync('chmod', ['u+w', notes]);
		await writeFile(join(root, note.path), text);
		await state.refresh();
		// The file holds that text now. That answers nothing about the save.
		expect(session.save.status).toBe('failed');
		expect(session.status).toBe('failed');
		expect(session.unsettled).toBe(true);
		expect(await state.settleAll()).toBe(1);
		// Nothing moves or removes the note past the failure.
		expect(state.sessionAt(note.path)).toBeUndefined();
		expect(state.noteAt(note.path)).toBe(session);
		expect(await state.rename(note.path, 'renamed.md')).toBe(
			'Save or discard the open edits first.',
		);
		expect((await state.deletionFor(note.path)).error).toBe(
			'Save or discard the open edits first.',
		);
		// The person keeps the file as it is: reloading reads it into the same
		// editor and ends the failure, writing nothing.
		expect(await session.reload()).toBeUndefined();
		expect(state.noteAt(note.path)).toBe(session);
		expect(session.save.status).toBe('idle');
		expect(session.unsettled).toBe(false);
		expect(await state.settleAll()).toBe(0);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(text);
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

	test('a clean note whose unknown rename stopped being tracked stays held, and nothing puts its file back at the old path', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		loseNext(folder.files, 'move', { landed: true });
		await state.rename(note.path, 'renamed.md');
		expect(state.stopTracking(note.path)).toBeUndefined();
		await state.refresh();
		expect(state.noteAt(note.path)).toBe(session);
		expect(session.hold).toMatchObject({
			kind: 'detached',
			change: { kind: 'move', to: 'notes/renamed.md', state: 'unconfirmed' },
		});
		expect(session.unsettled).toBe(true);
		// Nothing is typed or saved here until the person chooses.
		expect(typeBody(session, 'typed\n')).toBe(false);
		expect(session.retry()).toContain('stopped tracking');
		await expect(stat(join(root, note.path))).rejects.toThrow();
		// Saving here is a replace, so it never puts the file back.
		expect(session.saveHere()).toBeUndefined();
		expect(await saved(session)).toContain('not there');
		await expect(stat(join(root, note.path))).rejects.toThrow();
		// A reload finds nothing there and keeps the text.
		expect(await session.reload()).toContain('not in the folder');
		expect(textOf(session)).toBe(note.text);
		expect(state.noteAt(note.path)).toBe(session);
		expect(await readFile(join(root, 'notes/renamed.md'), 'utf8')).toBe(
			note.text,
		);
	});

	test('a stuck rename can stop being tracked: the text stays, both paths can be opened, and nothing is written', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		typeBody(session, 'Typed before the rename\n');
		const land = loseNext(folder.files, 'move', { landed: false });
		expect(await state.rename(note.path, 'renamed.md')).toContain(
			'not confirmed',
		);
		const typed = textOf(session);
		// While it is tracked, the destination gets no editor and nothing is reloaded.
		await state.open('notes/renamed.md');
		expect(state.noteAt('notes/renamed.md')).toBeUndefined();
		await state.open(note.path);
		expect(await session.reload()).toContain('Stop tracking');
		expect(state.noteAt(note.path)).toBe(session);

		expect(state.stopTracking(note.path)).toBeUndefined();
		expect(session.pathChange).toBeUndefined();
		expect(session.hold?.kind).toBe('detached');
		expect(shown(session).body).toBe('Typed before the rename\n');
		expect(session.unsettled).toBe(true);
		// The move that was sent lands after all; the destination opens as what is there.
		expectOk(await land());
		await state.refresh();
		await state.open('notes/renamed.md');
		expect(state.noteAt('notes/renamed.md')?.row).toMatchObject({
			body: 'Typed before the rename\n',
		});
		// Nothing was saved by itself, and the old path is not written back.
		expect(await saved(session)).toBeUndefined();
		await expect(stat(join(root, note.path))).rejects.toThrow();
		expect(textOf(session)).toBe(typed);
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
		// The person reloads the file; the list was read before it.
		expect(await session.reload()).toBeUndefined();
		expect(shown(session).fields.folderId).not.toBe(work.stem);
		expect(await state.deleteFolder(work)).toContain(
			'not in its file as listed',
		);
		expect(await readFile(join(root, note.path), 'utf8')).toBe(inHome);
		expect(await readFile(join(root, work.path), 'utf8')).toContain('Work');
		expect(session.unsettled).toBe(false);
	});

	test('an open member with typing is moved out through its editor, typing included', async () => {
		const { state, root, note, work } = await filed();
		const session = await openedNote(state, note.path);
		typeBody(session, 'typed in the member\n');
		// Until the list shows what the editor saved, the delete waits for it.
		expect(await state.deleteFolder(work)).toContain('Let it save');
		expect(await saved(session)).toBeUndefined();
		await state.refresh();
		expect(await state.deleteFolder(work)).toBeUndefined();
		await expect(stat(join(root, work.path))).rejects.toThrow();
		const written = inspectRow(
			honeycrispDefinition.tables.notes,
			await readFile(join(root, note.path), 'utf8'),
		);
		expect(written.fields.folderId).toBeNull();
		expect(written.body).toBe('typed in the member\n');
		expect(state.noteAt(note.path)).toBe(session);
	});

	test('a list action on an open note goes into its editor and saves over another program’s write', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		typeBody(session, 'my text\n');
		expect(await saved(session)).toBeUndefined();
		await writeFile(join(root, note.path), OUTSIDE);
		await state.refresh();
		// The editor was not reloaded: the last writer wins.
		expect(await state.patchNote(note.path, { pinned: true })).toBeUndefined();
		const written = inspectRow(
			honeycrispDefinition.tables.notes,
			await readFile(join(root, note.path), 'utf8'),
		);
		expect(written.fields).toMatchObject({ title: 'First', pinned: true });
		expect(written.body).toBe('my text\n');
		expect(shown(session).fields.pinned).toBe(true);
	});

	test('an action on an open note after a lost reply saves the complete current document again', async () => {
		const { state, seedNote, loseReplies, writes, text } = await browserProduct();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		loseReplies();
		typeBody(session, 'typed before the lost save\n');
		expect(await saved(session)).toContain('not confirmed');
		expect(session.status).toBe('unconfirmed');
		const sent = writes().length;
		loseReplies(false);
		expect(await state.patchNote(note.path, { pinned: true })).toBeUndefined();
		expect(writes()).toHaveLength(sent + 1);
		expect(shown(session)).toMatchObject({
			fields: { pinned: true }, body: 'typed before the lost save\n',
		});
		expect(text(note.path)).toContain('"pinned": true');
		expect(text(note.path)).toContain('typed before the lost save');
		expect(session.save.status).toBe('idle');
	});

	test('an action while a save runs proceeds behind it even when its reply is lost', async () => {
		const { state, seedNote, hold, held, release, loseReplies, text, writes } =
			await browserProduct();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const start = writes().length;
		hold();
		loseReplies();
		typeBody(session, 'typed\n');
		await until(() => held().length === 1, 'the first write');
		// The action gives the editor the whole note behind the running write.
		const pinning = state.patchNote(note.path, { pinned: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(shown(session).fields.pinned).toBe(true);
		expect(session.save.status).toBe('saving');
		release({ all: true });
		expect(await pinning).toContain('not confirmed');
		// Both writes lost their replies, but the newer complete document landed.
		expect(writes()).toHaveLength(start + 2);
		expect(text(note.path)).toContain('typed');
		expect(text(note.path)).toContain('"pinned": true');
		expect(shown(session)).toMatchObject({
			fields: { pinned: true },
			body: 'typed\n',
		});
		expect(await saved(session)).toContain('not confirmed');
		expect(writes()).toHaveLength(start + 2);
		loseReplies(false);
		expect(session.retry()).toBeUndefined();
		expect(await saved(session)).toBeUndefined();
		expect(text(note.path)).toContain('"pinned": true');
	});

	test('a folder is not deleted while an open member moved to another folder is not listed that way yet', async () => {
		const { state, root, note, work, home } = await filed();
		const session = await openedNote(state, note.path);
		expect(setFields(session, { folderId: home.stem })).toBeUndefined();
		expect(await state.deleteFolder(work)).toContain(
			'not in its file as listed',
		);
		expect(shown(session).fields.folderId).toBe(home.stem);
		expect(await readFile(join(root, work.path), 'utf8')).toContain('Work');
		// Once the list shows the move, the folder goes and the note stays in Home.
		expect(await saved(session)).toBeUndefined();
		await state.refresh();
		expect(await state.deleteFolder(work)).toBeUndefined();
		const written = inspectRow(
			honeycrispDefinition.tables.notes,
			await readFile(join(root, note.path), 'utf8'),
		);
		expect(written.fields.folderId).toBe(home.stem);
	});

	test('a folder is not deleted while an open note outside it was just put in it, and no member moves first', async () => {
		const { state, root, note, work, inWork, seedNote } = await filed();
		const other = await seedNote('Other');
		const session = await openedNote(state, other.path);
		expect(setFields(session, { folderId: work.stem })).toBeUndefined();
		expect(await state.deleteFolder(work)).toContain(
			'not in its file as listed',
		);
		expect(shown(session).fields.folderId).toBe(work.stem);
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

	test('an open member whose write fails or loses its reply while it is moved out keeps the folder', async () => {
		for (const fault of ['fail', 'lose'] as const) {
			const { state, seedNote, text, failWrites, loseReplies } =
				await browserProduct();
			const note = await seedNote();
			expect(await state.createFolder('Work')).toBeUndefined();
			const [work] = state.folders;
			if (work === undefined) throw new Error('The folder is not listed');
			expect(
				await state.patchNote(note.path, { folderId: work.stem }),
			).toBeUndefined();
			const session = await openedNote(state, note.path);
			if (fault === 'fail') failWrites();
			else loseReplies();
			const refusal = await state.deleteFolder(work);
			expect(refusal).toContain('could not be moved out');
			expect(text(work.path)).toContain('Work');
			const { save } = session;
			if (save.status !== 'failed') throw new Error('Expected a stopped save');
			if (fault === 'fail') {
				expect(save.error.name).toBe('Io');
				expect(session.status).toBe('failed');
				expect(text(note.path)).not.toContain('"folderId": null');
			} else {
				// The write landed; its reply did not. It is uncertain, never failed.
				expect(refusal).toContain('not confirmed');
				expect(session.status).toBe('unconfirmed');
				expect(state.notSaved).toBe(0);
				expect(text(note.path)).toContain('"folderId": null');
			}
		}
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
	test('a note shown as its file takes no field action, and its typing is saved exactly as typed', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		expect(await state.createFolder('Work')).toBeUndefined();
		const [work] = state.folders;
		if (work === undefined) throw new Error('The folder is not listed');
		expect(
			await state.patchNote(note.path, { folderId: work.stem }),
		).toBeUndefined();
		const session = await openedNote(state, note.path);
		expect(session.showFile(true)).toBeUndefined();
		const filed = await readFile(join(root, note.path), 'utf8');
		expect(textOf(session)).toBe(filed);
		session.setText(filed.replace('Hello', 'Typed as text'));
		for (const ask of [
			() => state.patchNote(note.path, { pinned: true }),
			() => state.trashNote(note.path),
			() => state.restoreNote(note.path),
		])
			expect(await ask()).toContain('open as a file');
		expect(await state.deleteFolder(work)).toContain('open as a file');
		expect(await readFile(join(root, work.path), 'utf8')).toContain('Work');
		expect(textOf(session)).toContain('Typed as text');
		expect(state.noteAt(note.path)).toBe(session);
		expect(state.sessionAt(note.path)).toBeUndefined();
		expect(await saved(session)).toBeUndefined();
		// Exactly the typed bytes: nothing else rewrote the file.
		const written = await readFile(join(root, note.path), 'utf8');
		expect(written).toBe(filed.replace('Hello', 'Typed as text'));
		expect(
			inspectRow(honeycrispDefinition.tables.notes, written).fields,
		).toMatchObject({ folderId: work.stem, pinned: false });
	});

	test('switching between the fields and the file writes nothing and discards nothing', async () => {
		const { state, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		typeBody(session, 'Typed in rich text\n');
		expect(await saved(session)).toBeUndefined();
		const before = await stat(join(root, note.path));
		expect(session.showFile(true)).toBeUndefined();
		expect(textOf(session)).toContain('Typed in rich text');
		expect(session.showFile(false)).toBeUndefined();
		expect(shown(session).body).toBe('Typed in rich text\n');
		expect(session.save.status).toBe('idle');
		expect((await stat(join(root, note.path))).mtimeMs).toBe(before.mtimeMs);
	});
});

describe('closing', () => {
	test('a hinted listing held when the page closes neither delays close nor changes state', async () => {
		const { state, folder, seedNote } = await product();
		await seedNote();
		await state.refresh();
		const { notes, listing, listError, listingError } = state;
		const list = folder.tables.notes.list;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let reads = 0;
		folder.tables.notes.list = async () => {
			reads += 1;
			const result = await list();
			started.resolve();
			await release.promise;
			return result;
		};
		try {
			expectOk(await folder.files.create('late.txt', 'Saved before close'));
			await started.promise;
			expectOk(
				await folder.files.replace(
					expectOk(await folder.files.read('late.txt')),
					'Newest before close',
				),
			);
			await state.close();
			release.resolve();
			await Bun.sleep(20);
			expect(state.notes).toBe(notes);
			expect(state.listing).toBe(listing);
			expect(state.listError).toBe(listError);
			expect(state.listingError).toBe(listingError);
			expect(reads).toBe(1);
		} finally {
			release.resolve();
			folder.tables.notes.list = list;
		}
	});

	test('a note still opening when the page closes is abandoned: its acquisition is aborted, an editor that answers anyway is not kept, and nothing opens after', async () => {
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
		// The late editor was opened; nothing keeps it or subscribed to it.
		expect(late?.error).toBeNull();
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

// ============================================================================
// A save that found no file, and a file that came back
// ============================================================================

describe('a save that found no file', () => {
	/**
	 * A note whose text was being written when its file was removed, so the
	 * write found no file; then another program put other text at the path.
	 * Nothing reads the path again by itself.
	 */
	async function returned() {
		const made = await browserProduct();
		const { state, seedNote, hold, held, release, drop, put } = made;
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		hold();
		typeBody(session, 'Mine\n');
		await until(() => held().length === 1, 'the write');
		drop(note.path);
		release({ all: true });
		expect(await saved(session)).toContain('not there');
		const theirs = OUTSIDE.replace('Outside', 'Theirs');
		put(note.path, theirs);
		return { ...made, note, session, theirs };
	}

	test('a file that came back is not written over by itself, and a reload shows it in place of the person’s text', async () => {
		const { state, note, session, text, theirs } = await returned();
		expect(session.missing).toBe(true);
		const mine = textOf(session);
		expect(mine).toContain('Mine');
		// No edit has arrived, so settling does not replay the failed request.
		expect(await state.settleAll()).toBe(1);
		expect(text(note.path)).toBe(theirs);
		// The person's reload is the one way the file's text replaces theirs.
		expect(await session.reload()).toBeUndefined();
		expect(textOf(session)).toBe(theirs);
		expect(session.save.status).toBe('idle');
		expect(session.missing).toBe(false);
		expect(state.noteAt(note.path)).toBe(session);
	});

	test('the person’s text can be saved as a new note instead, leaving the file that came back', async () => {
		const { state, note, session, text, theirs, paths } = await returned();
		const mine = textOf(session);
		expect(await state.recoverDraft(note.path)).toBeUndefined();
		expect(text(note.path)).toBe(theirs);
		const created = paths().filter(
			(path) => path.startsWith('notes/') && path !== note.path,
		);
		expect(created).toHaveLength(1);
		const [at] = created;
		if (at === undefined) throw new Error('No new note');
		expect(text(at)).toBe(mine);
		expect(state.selectedPath).toBe(at);
	});

	test('a stopped-tracking rename whose old path is gone can save the person’s text as a note there', async () => {
		const { state, folder, root, seedNote } = await product();
		const note = await seedNote();
		const session = await openedNote(state, note.path);
		const land = loseNext(folder.files, 'move', { landed: false });
		expect(await state.rename(note.path, 'renamed.md')).toContain(
			'not confirmed',
		);
		const typed = textOf(session);
		expect(state.stopTracking(note.path)).toBeUndefined();
		expectOk(await land());
		await state.refresh();
		// The person's reload finds nothing at the old path and keeps the text.
		expect(await session.reload()).toContain('not in the folder');
		expect(session.missing).toBe(true);
		expect(await state.recoverDraft(note.path)).toBeUndefined();
		expect(await readFile(join(root, note.path), 'utf8')).toBe(typed);
		expect(await readFile(join(root, 'notes/renamed.md'), 'utf8')).toBe(
			note.text,
		);
		expect(state.noteAt(note.path)?.row.text).toBe(typed);
	});
});
