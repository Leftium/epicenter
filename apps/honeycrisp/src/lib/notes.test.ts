/**
 * Notes state tests
 *
 * Drives the real notes state against a folder whose file reads resolve only
 * when the test says so, and observes the selection from effects the way
 * mounted components do.
 *
 * Key behaviors:
 * - A raw file selected after a note shows as loading, then as its text
 * - A component that reads the selection while it is torn down does not
 *   stop the selection from following the file that is loading
 * - Concurrent opens share a read, and refreshes never overlap listings
 * - A removed binary keeps its selected path without a selected file
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { hashBytes } from '@epicenter/folder';
import type { NotesHost } from './platform/types.js';

const { createNotes } = await import('./notes.svelte.ts');
const { constant, watch } = await import('./effects.test-support.svelte.ts');

const encoder = new TextEncoder();
const NOTE = '---\ntitle: A\n---\nbody\n';
const RAW = '{}\n';

/** A folder with one note and `kv.json`, whose raw read waits for `release`. */
async function open() {
	const note = {
		path: 'notes/a.md',
		stem: 'a',
		source: NOTE,
		sha256: await hashBytes(encoder.encode(NOTE)),
		fields: { title: 'A' },
		body: 'body\n',
	};
	const bytes = encoder.encode(RAW);
	const sha256 = await hashBytes(bytes);
	let release = () => {};
	let reads = 0;
	const host = {
		folder: {
			tables: {
				notes: {
					list: async () => ({
						data: { entries: [note], unreadable: [] },
						error: null,
					}),
				},
				folders: {
					list: async () => ({
						data: { entries: [], unreadable: [] },
						error: null,
					}),
				},
			},
			files: {
				list: async () => ({
					data: {
						files: [
							{ path: 'kv.json', size: bytes.byteLength },
							{ path: note.path, size: NOTE.length },
						],
						directories: ['notes'],
					},
					error: null,
				}),
				read: async () => {
					reads += 1;
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return { data: { bytes, sha256 }, error: null };
				},
			},
			git: {
				snapshot: {},
				subscribe: () => () => {},
				status: async () => undefined,
			},
			onFilesChanged: () => () => {},
		},
		terminal: { cwd: '/', description: '' },
	} as unknown as NotesHost;
	const notes = createNotes(host);
	await notes.refreshAll();
	return { notes, release: () => release(), reads: () => reads };
}

/** Give scheduled Svelte effects a turn to run after the state change. */
const rendered = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a raw file opened after a note shows its text once it is read, whatever read the selection during teardown', async () => {
	const { notes, release } = await open();
	// The view holds the selection the way its template does.
	const viewed = constant(() => notes.selection);
	const shown: (string | undefined)[] = [];
	const stop = watch(() => {
		const selection = viewed.current;
		shown.push(
			selection?.kind === 'file' ? selection.file.kind : selection?.kind,
		);
	});
	// A component for the selected note: when the selection moves on, its
	// cleanup still reads what it was showing.
	const stopDetail = watch(() => {
		notes.selectedPath;
		return () => void viewed.current;
	});
	await rendered();
	await notes.open('notes/a.md');
	await rendered();
	const opening = notes.open('kv.json');
	await rendered();
	expect(shown).toEqual([undefined, 'note', 'loading']);
	release();
	await opening;
	await rendered();
	expect(shown).toEqual([undefined, 'note', 'loading', 'text']);
	const selection = notes.selection;
	expect(selection?.kind === 'file' && selection.file.kind).toBe('text');
	expect(
		selection?.kind === 'file' &&
			selection.file.kind === 'text' &&
			selection.file.session.buffer,
	).toBe(RAW);
	stop();
	stopDetail();
});

test('overlapping opens of one raw path load it once and keep one session', async () => {
	const { notes, release, reads } = await open();
	const first = notes.open('kv.json');
	await rendered();
	await notes.open('kv.json');
	expect(reads()).toBe(1);
	release();
	await first;
	const session = notes.sessionAt('kv.json');
	expect(session?.buffer).toBe(RAW);
	await notes.open('notes/a.md');
	await notes.open('kv.json');
	expect(notes.sessionAt('kv.json')).toBe(session);
	expect(reads()).toBe(1);
});

test('refresh requests during a read wait for one follow-up without overlapping listings', async () => {
	const { notes } = await open();
	const table = notes.host.folder.tables.notes;
	const list = table.list;
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let calls = 0;
	let active = 0;
	let maximum = 0;
	table.list = async () => {
		calls += 1;
		active += 1;
		maximum = Math.max(maximum, active);
		try {
			if (calls === 1) {
				started.resolve();
				await release.promise;
			}
			return await list();
		} finally {
			active -= 1;
		}
	};
	const first = notes.refresh();
	await started.promise;
	const again = notes.refresh();
	const also = notes.refresh();
	expect(calls).toBe(1);
	release.resolve();
	await Promise.all([first, again, also]);
	expect(calls).toBe(2);
	expect(maximum).toBe(1);
	expect(notes.notes[0]?.source).toBe(NOTE);
});

test('an externally removed binary keeps its selected path without a selected file', async () => {
	const { notes } = await open();
	const files = notes.host.folder.files;
	const bytes = new Uint8Array([0]);
	const sha256 = await hashBytes(bytes);
	files.read = async (path) => ({
		data: { path, bytes, sha256 },
		error: null,
	});
	await notes.open('kv.json');
	const selected = notes.selection;
	expect(selected?.kind === 'file' && selected.file.kind).toBe('binary');
	files.list = async () => ({
		data: { files: [], directories: [] },
		error: null,
	});
	await notes.refresh();
	expect(notes.selectedPath).toBe('kv.json');
	expect(notes.selection).toBeUndefined();
});
