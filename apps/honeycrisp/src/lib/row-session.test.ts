/**
 * Row Session Tests
 *
 * Drives one note session, the app's policy around a row editor, against a
 * file whose save replies can be held, failed, or lost. The editor is the
 * contract-following double in `row-editor.test-support.ts`; the notes over a
 * real directory, in `notes.folder.test.ts`, use the folder's own editor.
 *
 * Key behaviors:
 * - Opening writes nothing; a save writes the complete canonical document,
 *   unknown values included
 * - Typing saves after a pause; typing during a save stays a draft and saves next
 * - A failed or unconfirmed save keeps the input and stops autosave; only a
 *   save the person asks for, confirmed, starts it again
 * - A read that finds an unconfirmed save's content makes the draft clean,
 *   and the save stays not confirmed
 * - A change on disk under unsaved input stops autosave until the person chooses
 * - While input is fenced nothing is taken, and settling waits for an admitted save
 * - A move keeps typing and saves nothing; the next editor takes the document
 */
import './svelte-modules.test-support.js';
import { describe, expect, test } from 'bun:test';
import type { InstantString } from '@epicenter/definition';
import type { NoteFields } from './data.js';
import { inspectNote } from './inspect.test-support.js';
import { noteBody } from './note-source.js';
import { openFakeRowEditor } from './row-editor.test-support.js';

const { createRowSession } = await import('./row-session.svelte.ts');

const DECLARED = [
	'folderId',
	'title',
	'pinned',
	'createdAt',
	'updatedAt',
	'deletedAt',
];
const NOTE = [
	'---',
	'# kept by hand',
	'title: A',
	'folderId: null',
	'pinned: false',
	'createdAt: "2026-10-01T00:00:00.000Z"',
	'updatedAt: "2026-10-01T00:00:00.000Z"',
	'deletedAt: null',
	'extra: {"a": 1}',
	'---',
	'body',
	'',
].join('\n');
/** NOTE as a save writes it: declared keys in order, then the rest, all quoted JSON. */
const canonical = (title: string, body = 'body\n') =>
	[
		'---',
		'"folderId": null',
		`"title": ${JSON.stringify(title)}`,
		'"pinned": false',
		'"createdAt": "2026-10-01T00:00:00.000Z"',
		'"updatedAt": "2026-10-01T00:00:00.000Z"',
		'"deletedAt": null',
		'"extra": {"a": 1}',
		'---',
		body,
	].join('\n');
/** Longer than the typing pause before an autosave. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 700));

async function until(check: () => boolean, what: string) {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** One note file, whose writes can be held and whose replies can fail or be lost. */
function disk(initial: string = NOTE) {
	let source: string | undefined = initial;
	const writes: string[] = [];
	let held: PromiseWithResolvers<void> | undefined;
	let reply: { kind: 'ok' } | { kind: 'fail' } | { kind: 'lose'; landed: boolean } =
		{ kind: 'ok' };
	const hints = new Set<() => void>();
	return {
		file: {
			read: () => source,
			async write(text: string) {
				await held?.promise;
				if (reply.kind === 'fail')
					return { error: { name: 'Io', message: 'The disk is full' } };
				if (reply.kind === 'ok' || reply.landed) {
					source = text;
					writes.push(text);
				}
				return reply.kind === 'lose'
					? { error: { name: 'Unconfirmed', message: 'The reply was lost' } }
					: {};
			},
			watch(hint: () => void) {
				hints.add(hint);
				return () => hints.delete(hint);
			},
		},
		writes,
		get source() {
			return source;
		},
		/** Another program writes the file, and the folder hints at it. */
		outside(text: string | undefined) {
			source = text;
			for (const hint of hints) hint();
		},
		hold() {
			held = Promise.withResolvers<void>();
		},
		release() {
			held?.resolve();
			held = undefined;
		},
		answer(next: typeof reply) {
			reply = next;
		},
	};
}

async function open(
	file = disk(),
	{
		path = 'notes/a.md',
		admits = () => true,
	}: { path?: string; admits?: () => boolean } = {},
) {
	const opened = await openFakeRowEditor<NoteFields>({
		path,
		declared: DECLARED,
		inspect: inspectNote,
		file: file.file,
	});
	if (opened.error !== null) throw new Error(opened.error.message);
	return createRowSession(opened.data, { admits });
}

describe('saving', () => {
	test('opening writes nothing; a save writes the complete document in one canonical form', async () => {
		const file = disk();
		const session = await open(file);
		expect(session.status).toBe('saved');
		expect(session.dirty).toBe(false);
		expect(file.writes).toEqual([]);
		expect(session.change({ fields: { title: 'B' } })).toBe(true);
		expect(session.status).toBe('dirty');
		expect(await session.settle()).toBe(true);
		// The unknown value is kept; the comment and the YAML spelling are not.
		expect(file.writes).toEqual([canonical('B')]);
		expect(session.status).toBe('saved');
	});

	test('typing saves by itself after a pause', async () => {
		const file = disk();
		const session = await open(file);
		session.change({ fields: { title: 'B' } });
		expect(file.writes).toEqual([]);
		await pause();
		expect(file.writes).toEqual([canonical('B')]);
	});

	test('typing during a save stays a draft and saves next', async () => {
		const file = disk();
		const session = await open(file);
		file.hold();
		session.change({ fields: { title: 'B' } });
		const saving = session.saveNow();
		await until(() => session.state.saving !== undefined, 'the save');
		expect(session.change({ fields: { title: 'C' } })).toBe(true);
		expect(session.status).toBe('saving');
		file.release();
		expect(await saving).toBeUndefined();
		expect(file.writes).toEqual([canonical('B')]);
		expect(session.dirty).toBe(true);
		await pause();
		expect(file.writes).toEqual([canonical('B'), canonical('C')]);
		expect(session.status).toBe('saved');
	});

	test('a body edit moves updatedAt', async () => {
		const session = await open();
		const body = noteBody(
			() => session,
			() => '2026-10-02T00:00:00.000Z' as InstantString,
		);
		expect(body.input('new\n')).toBe(true);
		expect(session.state.document.body).toBe('new\n');
		expect(session.state.document.fields.updatedAt).toBe(
			'2026-10-02T00:00:00.000Z',
		);
	});
});

describe('a save that does not end saved', () => {
	test('a failed save keeps the input and stops autosave until a save is asked for', async () => {
		const file = disk();
		const session = await open(file);
		file.answer({ kind: 'fail' });
		session.change({ fields: { title: 'B' } });
		expect(await session.settle()).toBe(false);
		expect(session.status).toBe('failed');
		expect(session.paused).toBe(true);
		expect(session.state.document.fields.title).toBe('B');
		// Typing goes on, and nothing saves by itself.
		session.change({ fields: { title: 'C' } });
		await pause();
		expect(file.writes).toEqual([]);
		expect(session.unsettled).toBe(true);
		// The person asks: a new attempt, with what is typed now.
		file.answer({ kind: 'ok' });
		expect(await session.saveNow()).toBeUndefined();
		expect(file.writes).toEqual([canonical('C')]);
		expect(session.paused).toBe(false);
		session.change({ fields: { title: 'D' } });
		await pause();
		expect(file.writes.at(-1)).toBe(canonical('D'));
	});

	test('a lost reply whose save landed: the file holds the draft, and the save stays not confirmed', async () => {
		const file = disk();
		const session = await open(file);
		file.answer({ kind: 'lose', landed: true });
		session.change({ fields: { title: 'B' } });
		expect(await session.settle()).toBe(false);
		// The read after the save found exactly the draft: nothing is unsaved.
		expect(session.dirty).toBe(false);
		// Which save put it there is not known, so the history is unchanged.
		expect(session.state.lastSave?.kind).toBe('unconfirmed');
		expect(session.status).toBe('unconfirmed');
		expect(session.unsettled).toBe(true);
		session.change({ fields: { title: 'C' } });
		await pause();
		expect(file.writes).toEqual([canonical('B')]);
		// Saving again is a new attempt, never blocked by the old one.
		file.answer({ kind: 'ok' });
		expect(await session.saveNow()).toBeUndefined();
		expect(file.writes).toEqual([canonical('B'), canonical('C')]);
		expect(session.status).toBe('saved');
		expect(session.unsettled).toBe(false);
	});

	test('keeping the file is the person’s choice about a lost reply: the hold ends, and the save history does not change', async () => {
		const file = disk();
		const session = await open(file);
		file.answer({ kind: 'lose', landed: true });
		session.change({ fields: { title: 'B' } });
		await session.settle();
		expect(session.status).toBe('unconfirmed');
		const seen = session.state.observation;
		if (seen.kind !== 'present') throw new Error('Expected a present file');
		expect(session.adopt(seen.revision)).toBe(true);
		// What that save came to is still not known, and the editor still says so.
		expect(session.state.lastSave?.kind).toBe('unconfirmed');
		expect(session.paused).toBe(false);
		expect(session.status).toBe('saved');
		expect(session.unsettled).toBe(false);
		// Saving by itself starts again.
		file.answer({ kind: 'ok' });
		session.change({ fields: { title: 'C' } });
		await pause();
		expect(file.writes).toEqual([canonical('B'), canonical('C')]);
	});

	test('a failed save stays held when a read finds the draft in the file: the hold does not depend on the draft differing', async () => {
		const file = disk();
		const session = await open(file);
		file.answer({ kind: 'fail' });
		session.change({ fields: { title: 'B' } });
		await session.settle();
		// Another program writes exactly the draft.
		file.outside(canonical('B'));
		await session.refresh();
		expect(session.dirty).toBe(false);
		expect(session.status).toBe('failed');
		expect(session.hold?.kind).toBe('failed');
		expect(session.unsettled).toBe(true);
		expect(await session.settle()).toBe(false);
		// Nor does it let a rename or delete start.
		const moved = await session.changePath(
			(from) => ({ kind: 'move', from, to: 'notes/b.md' }),
			async () => ({ kind: 'done', value: undefined }),
		);
		expect(moved.kind).toBe('unsettled');
	});

	test('a failed save stays held through a later read, until a save the person asks for', async () => {
		const file = disk();
		const session = await open(file);
		file.answer({ kind: 'fail' });
		session.change({ fields: { title: 'B' } });
		await session.settle();
		file.answer({ kind: 'ok' });
		await session.refresh();
		session.change({ fields: { title: 'C' } });
		expect(await session.settle()).toBe(false);
		expect(file.writes).toEqual([]);
		expect(session.status).toBe('failed');
		expect(await session.saveNow()).toBeUndefined();
		expect(file.writes).toEqual([canonical('C')]);
	});

	test('a lost reply whose save never landed keeps the draft, and the next save sends what is typed now', async () => {
		const file = disk();
		const session = await open(file);
		file.answer({ kind: 'lose', landed: false });
		session.change({ fields: { title: 'B' } });
		await session.settle();
		expect(session.status).toBe('unconfirmed');
		expect(session.dirty).toBe(true);
		expect(session.state.lastSave).toMatchObject({
			kind: 'unconfirmed',
			attempt: { source: canonical('B') },
		});
		session.change({ fields: { title: 'C' } });
		file.answer({ kind: 'ok' });
		expect(await session.saveNow()).toBeUndefined();
		expect(file.writes).toEqual([canonical('C')]);
		expect(session.status).toBe('saved');
	});

	test('a document the table refuses is kept on screen and not written', async () => {
		const file = disk();
		const session = await open(file);
		expect(session.change({ fields: { pinned: 'maybe' } })).toBe(true);
		expect(session.state.reading.issues.length).toBeGreaterThan(0);
		await pause();
		expect(file.writes).toEqual([]);
		expect(await session.saveNow()).toBe(
			session.state.reading.issues[0]?.message,
		);
		expect(session.state.document.fields.pinned).toBe('maybe');
		expect(session.unsettled).toBe(true);
	});
});

describe('the file changes', () => {
	const OUTSIDE = canonical('Outside', 'theirs\n');

	test('a clean session follows a valid read without writing', async () => {
		const file = disk();
		const session = await open(file);
		file.outside(OUTSIDE);
		await session.refresh();
		expect(session.state.document.fields.title).toBe('Outside');
		expect(session.status).toBe('saved');
		expect(file.writes).toEqual([]);
	});

	test('a change under unsaved input stops autosave, and taking the file is the person’s choice', async () => {
		const file = disk();
		const session = await open(file);
		session.change({ fields: { title: 'Mine' } });
		file.outside(OUTSIDE);
		await session.refresh();
		expect(session.status).toBe('conflict');
		await pause();
		expect(file.writes).toEqual([]);
		const seen = session.external;
		if (seen?.kind !== 'present') throw new Error('Expected a present file');
		expect(session.adopt(seen.revision)).toBe(true);
		expect(session.state.document.fields.title).toBe('Outside');
		expect(session.status).toBe('saved');
		expect(file.writes).toEqual([]);
	});

	test('keeping the draft over the file is one save the person asks for', async () => {
		const file = disk();
		const session = await open(file);
		session.change({ fields: { title: 'Mine' } });
		file.outside(OUTSIDE);
		await session.refresh();
		expect(await session.saveNow()).toBeUndefined();
		expect(file.source).toBe(canonical('Mine'));
		expect(session.status).toBe('saved');
	});

	test('a deleted file keeps the draft and saves nothing by itself', async () => {
		const file = disk();
		const session = await open(file);
		session.change({ fields: { title: 'Mine' } });
		file.outside(undefined);
		await session.refresh();
		expect(session.external?.kind).toBe('missing');
		await pause();
		expect(file.source).toBeUndefined();
		expect(session.state.document.fields.title).toBe('Mine');
	});
});

describe('closing and renaming', () => {
	test('while input is fenced nothing is taken, and settling waits for an admitted save', async () => {
		const file = disk();
		let admits = true;
		const session = await open(file, { admits: () => admits });
		file.hold();
		session.change({ fields: { title: 'B' } });
		const saving = session.saveNow();
		await until(() => session.state.saving !== undefined, 'the save');
		admits = false;
		expect(session.change({ fields: { title: 'late' } })).toBe(false);
		expect(await session.saveNow()).toContain('closing');
		let settled = false;
		const settling = session.settle().then((done) => {
			settled = true;
			return done;
		});
		await pause();
		expect(settled).toBe(false);
		file.release();
		expect(await settling).toBe(true);
		await saving;
		expect(file.writes).toEqual([canonical('B')]);
		expect(session.state.document.fields.title).toBe('B');
	});

	test('a move keeps typing and saves nothing; the editor at the new path takes the document', async () => {
		const from = disk();
		const session = await open(from);
		const moved = Promise.withResolvers<{ kind: 'done'; value: undefined }>();
		const moving = session.changePath(
			(capture) => ({ kind: 'move', from: capture, to: 'notes/b.md' }),
			() => moved.promise,
		);
		await until(() => session.pathChange !== undefined, 'the move');
		expect(session.status).toBe('saving');
		expect(session.change({ fields: { title: 'Typed during' } })).toBe(true);
		await pause();
		expect(from.writes).toEqual([]);
		moved.resolve({ kind: 'done', value: undefined });
		expect((await moving).kind).toBe('done');
		// Until the owner reopens it, the old editor saves nothing more.
		expect(session.pathChange?.state).toBe('sent');
		const to = disk(from.source);
		const next = await open(to, { path: 'notes/b.md' });
		expect(next.carry(session.state.document)).toBe(true);
		await session.dispose();
		expect(next.state.document).toEqual(session.state.document);
		expect(await next.settle()).toBe(true);
		expect(to.writes).toEqual([canonical('Typed during')]);
		expect(from.writes).toEqual([]);
	});

	test('a move whose reply is lost keeps the session, takes input, and saves nothing', async () => {
		const file = disk();
		const session = await open(file);
		const outcome = await session.changePath(
			(capture) => ({ kind: 'move', from: capture, to: 'notes/b.md' }),
			async () =>
				({
					kind: 'unconfirmed',
					name: 'Unconfirmed',
					message: 'The reply was lost',
				}) as const,
		);
		expect(outcome.kind).toBe('unconfirmed');
		expect(session.status).toBe('unconfirmed');
		expect(session.change({ fields: { title: 'Kept' } })).toBe(true);
		await pause();
		expect(file.writes).toEqual([]);
		expect(session.unsettled).toBe(true);
		// The person stops tracking it: the draft stays, held, and nothing is
		// saved by itself.
		expect(session.detach()).toBe(true);
		expect(session.pathChange).toBeUndefined();
		expect(session.hold).toMatchObject({ kind: 'detached' });
		expect(session.hold?.message).toContain('notes/b.md');
		expect(session.state.document.fields.title).toBe('Kept');
		expect(session.change({ fields: { title: 'Kept and more' } })).toBe(true);
		await pause();
		expect(file.writes).toEqual([]);
		expect(session.unsettled).toBe(true);
		// Saving is the person's choice.
		expect(await session.saveNow()).toBeUndefined();
		expect(file.writes).toEqual([canonical('Kept and more')]);
		expect(session.hold).toBeUndefined();
	});
});
