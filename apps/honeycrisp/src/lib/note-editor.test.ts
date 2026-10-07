/**
 * Note Editor Tests
 *
 * Drives one note's editor, the app's policy around the folder's row editor,
 * over Honeycrisp's real browser folder on the in-memory OPFS stand-in. The
 * row editor is the production `table.edit`; a write is held, failed, or
 * loses its reply at the stand-in's file streams, and another program's
 * writes and removals go below the folder's API.
 *
 * Key behaviors:
 * - Opening writes nothing; `set` gives the editor the complete note at
 *   once, unknown keys included, and a field left out is removed
 * - A body moves `updatedAt`; a title, or the same body, does not
 * - Typing during a held write saves only the latest input next, with no
 *   idle moment between the two writes
 * - A failed or unconfirmed write keeps the text editable; later typing
 *   saves again
 * - Another program's change leaves the open text alone until the person
 *   reloads; a reload that fails keeps the text and its save state
 * - Typed text the editor refuses stays in its own control with the reason;
 *   it blocks only a document that changes its field, and only its own
 *   control clears it
 * - The rich-text view's unchanged note is acknowledged without a save, and
 *   only through every gate; any other unchanged note is saved again
 * - Fences and release refuse input; flushing waits for admitted writes
 */
import './svelte-modules.test-support.js';
import { afterEach, describe, expect, test } from 'bun:test';
import type { InstantString } from '@epicenter/definition';
import {
	type CanonicalDocument,
	formatCanonicalDocument,
	parseCanonicalDocument,
} from '@epicenter/folder';
import { expectOk } from 'wellcrafted/testing';
import { honeycrispDefinition } from './data.js';
import {
	noteText,
	openNotesFolder,
	settle,
	until,
} from './folder.test-support.js';
import type { NoteEditor } from './note-editor.svelte.js';
import { withBody } from './note-source.js';

const { createNoteEditor, noteSaveProblem } = await import(
	'./note-editor.svelte.ts'
);

const PATH = 'notes/a.md';
const DECLARED = Object.keys(honeycrispDefinition.tables.notes.fields);
const NOW = '2026-10-02T00:00:00.000Z' as InstantString;
const cleanup: (() => unknown)[] = [];

afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});

/** The canonical text of `text` with `change` applied to its fields. */
function canonical(
	text: string,
	change: Record<string, unknown> = {},
	body?: string,
): string {
	const document = expectOk(parseCanonicalDocument(text));
	const fields: Record<string, unknown> = { ...document.fields, ...change };
	for (const [key, value] of Object.entries(change))
		if (value === undefined) delete fields[key];
	return expectOk(
		formatCanonicalDocument(
			{
				fields: fields as typeof document.fields,
				body: body ?? document.body,
			},
			DECLARED,
		),
	);
}

async function open(initial = noteText()) {
	const fixture = await openNotesFolder();
	cleanup.push(fixture.close);
	await fixture.write(PATH, initial);
	const editor = expectOk(await fixture.folder.tables.notes.edit('a'));
	let admitting = true;
	const session = createNoteEditor(editor, {
		path: PATH,
		admits: () => admitting,
	});
	cleanup.push(() => session.release());
	/** Every save state the editor reported, in order. */
	const saves: string[] = [];
	cleanup.push(
		editor.subscribe(() => {
			const { status } = editor.get().save;
			if (saves.at(-1) !== status) saves.push(status);
		}),
	);
	const attempts = () =>
		fixture.writes().filter((path) => path === PATH).length;
	const created = attempts();
	/** Write attempts at the note since it opened. */
	const notes = () => attempts() - created;
	return {
		...fixture,
		editor,
		session,
		saves,
		notes,
		fence() {
			admitting = false;
		},
	};
}

/** The structured note the views show, or a failure. */
function noteOf(session: NoteEditor) {
	const { row } = session;
	if (row.status !== 'valid') throw new Error('The note does not read');
	return row;
}

const fieldsOf = (session: NoteEditor) => noteOf(session).fields;

/** The whole note as it is now with `fields` put in, as a field control composes it. */
function withFields(
	session: NoteEditor,
	fields: Record<string, unknown>,
): CanonicalDocument {
	const row = noteOf(session);
	return { ...row, fields: { ...row.fields, ...fields } as typeof row.fields };
}

/** What the title control gives the editor. */
const typeTitle = (session: NoteEditor, title: string) =>
	session.set(withFields(session, { title }), { control: 'title' });

/** What Source gives the editor. */
const typeSource = (session: NoteEditor, body: string) =>
	session.set(withBody(noteOf(session), body, NOW), { control: 'body' });

describe('typing and saving', () => {
	test('opening writes nothing; set gives the editor the complete note at once, unknown keys kept', async () => {
		const hand = [
			'---',
			'# kept until a save',
			"title: 'Hand'",
			'owner: {name: one, tags: [two]}',
			'folderId: null',
			'pinned: false',
			'createdAt: "2026-10-01T00:00:00.000Z"',
			'updatedAt: "2026-10-01T00:00:00.000Z"',
			'deletedAt: null',
			'---',
			'Keep this body.',
			'',
		].join('\n');
		const { session, text } = await open(hand);
		await settle();
		expect(text(PATH)).toBe(hand);
		expect(session.row).toMatchObject({ status: 'valid', text: hand });
		expect(session.status).toBe('saved');

		expect(
			session.set(withFields(session, { title: 'Typed' })),
		).toBeUndefined();
		const saved = canonical(hand, { title: 'Typed' });
		// The editor holds it now; there is no draft beside it.
		expect(session.row.text).toBe(saved);
		expect(session.save.status).toBe('saving');
		expect((await session.waitForSaves()).error).toBeNull();
		expect(text(PATH)).toBe(saved);
		expect(saved).toContain('"owner": {"name": "one", "tags": ["two"]}');
		expect(saved).not.toContain('# kept');
		expect(saved.endsWith('---\nKeep this body.\n')).toBe(true);
		expect(session.status).toBe('saved');
		expect(session.unsettled).toBe(false);
	});

	test('a body moves updatedAt in the same edit; a title, or the same body, does not', async () => {
		const { session, text } = await open();
		expect(typeSource(session, 'New body.\n')).toBeUndefined();
		expect(noteOf(session).body).toBe('New body.\n');
		await session.waitForSaves();
		expect(text(PATH)).toBe(
			canonical(noteText(), { updatedAt: NOW }, 'New body.\n'),
		);
		expect(typeTitle(session, 'Retitled')).toBeUndefined();
		expect(fieldsOf(session).updatedAt).toBe(NOW);
		// The same body is the same note, not a newer one.
		const row = noteOf(session);
		expect(
			withBody(row, row.body, '2026-10-03T00:00:00.000Z' as InstantString),
		).toBe(row);
	});

	test('typing during a held write saves only the latest input next, with no idle moment', async () => {
		const { session, text, hold, held, release, saves } = await open();
		hold();
		session.set(withFields(session, { title: 'First' }));
		await until(() => held().length === 1, 'the first write to wait');
		session.set(withFields(session, { title: 'Second' }));
		session.set(withFields(session, { title: 'Third' }));
		expect(fieldsOf(session).title).toBe('Third');
		release();
		await until(() => held().length === 1, 'the next write to wait');
		expect(text(PATH)).toBe(canonical(noteText(), { title: 'First' }));
		expect(session.save.status).toBe('saving');
		release({ all: true });
		expect((await session.waitForSaves()).error).toBeNull();
		// "Second" was superseded before it was attempted.
		expect(text(PATH)).toBe(canonical(noteText(), { title: 'Third' }));
		expect(saves).toEqual(['saving', 'idle']);
	});

	test('a field left out is removed, and text that no longer reads as a note is saved all the same', async () => {
		const { session, text } = await open();
		const { deletedAt: _removed, ...kept } = fieldsOf(session);
		expect(session.set({ ...noteOf(session), fields: kept })).toBeUndefined();
		// Whole validity decides which view shows; the fields give way to the file.
		expect(session.row.status).toBe('invalid');
		await session.waitForSaves();
		expect(text(PATH)).not.toContain('deletedAt');
		expect(text(PATH)).toContain('"owner"');
	});
});

describe('a write that does not end saved', () => {
	test('a failed write keeps the text editable and later typing saves again', async () => {
		const { session, text, failWrites, saves, notes } = await open();
		failWrites();
		session.set(withFields(session, { title: 'Lost?' }));
		const { error } = await session.waitForSaves();
		expect(error?.name).toBe('Io');
		expect(session.save).toMatchObject({
			status: 'failed',
			error: { name: 'Io' },
		});
		expect(session.status).toBe('failed');
		expect(session.unsettled).toBe(true);
		const attempts = notes();
		failWrites(false);
		// The text stays editable, and another edit starts another attempt.
		expect(
			session.set(withFields(session, { title: 'Newer' })),
		).toBeUndefined();
		await settle();
		expect(fieldsOf(session).title).toBe('Newer');
		expect(notes()).toBe(attempts + 1);
		expect(saves).toEqual(['saving', 'failed', 'saving', 'idle']);
		expect((await session.waitForSaves()).error).toBeNull();
		expect(text(PATH)).toBe(canonical(noteText(), { title: 'Newer' }));
		expect(session.status).toBe('saved');
	});

	test('an unconfirmed write is uncertainty in the folder’s own words, and Save again is a new attempt', async () => {
		const { session, text, loseReplies } = await open();
		loseReplies();
		session.set(withFields(session, { title: 'Maybe' }));
		await session.waitForSaves();
		const { save } = session;
		if (save.status !== 'failed') throw new Error('expected a failed save');
		expect(save.error.name).toBe('Unconfirmed');
		expect(session.status).toBe('unconfirmed');
		expect(noteSaveProblem(save.error)).toContain(save.error.message);
		expect(noteSaveProblem(save.error)).toContain('may or may not');
		// The write landed; nothing here concludes that from the file.
		expect(text(PATH)).toBe(canonical(noteText(), { title: 'Maybe' }));
		expect(session.save.status).toBe('failed');
		loseReplies(false);
		expect(session.retry()).toBeUndefined();
		expect(session.save.status).toBe('saving');
		await session.waitForSaves();
		expect(session.status).toBe('saved');
	});

	test('Try again sends the exact text the editor holds, comments and quoting included', async () => {
		const hand = [
			'---',
			'# a comment',
			"title: 'Quoted'",
			'folderId: null',
			'pinned: false',
			'createdAt: "2026-10-01T00:00:00.000Z"',
			'updatedAt: "2026-10-01T00:00:00.000Z"',
			'deletedAt: null',
			'---',
			'Body.',
			'',
		].join('\n');
		const { session, text, failWrites } = await open();
		expect(session.showFile(true)).toBeUndefined();
		failWrites();
		session.setText(hand);
		await session.waitForSaves();
		expect(session.save.status).toBe('failed');
		failWrites(false);
		expect(session.retry()).toBeUndefined();
		await session.waitForSaves();
		expect(text(PATH)).toBe(hand);
	});

	test('a deleted file fails the next save with the text kept editable, and nothing writes it back', async () => {
		const { session, text, drop } = await open();
		drop(PATH);
		session.set(withFields(session, { title: 'Mine' }));
		expect((await session.waitForSaves()).error?.name).toBe('NotFound');
		expect(session.missing).toBe(true);
		expect(fieldsOf(session).title).toBe('Mine');
		expect(session.set(withFields(session, { title: 'More' }))).toBeUndefined();
		session.retry();
		expect((await session.waitForSaves()).error?.name).toBe('NotFound');
		expect(text(PATH)).toBeUndefined();
	});
});

describe('the file changes', () => {
	test('another program’s change leaves the open text alone until the person reloads', async () => {
		const { session, text, put, notes } = await open();
		const other = noteText({ title: 'Elsewhere' });
		put(PATH, other);
		await settle();
		expect(fieldsOf(session).title).toBe('A');
		expect(session.status).toBe('saved');
		expect(await session.reload()).toBeUndefined();
		expect(session.row.text).toBe(other);
		expect(text(PATH)).toBe(other);
		expect(notes()).toBe(0);
	});

	test('typing over another program’s change saves over it: the last writer wins', async () => {
		const { session, text, put } = await open();
		put(PATH, noteText({ title: 'Theirs' }));
		session.set(withFields(session, { title: 'Mine' }));
		await session.waitForSaves();
		expect(text(PATH)).toBe(canonical(noteText(), { title: 'Mine' }));
	});

	test('a reload takes no input while it reads', async () => {
		const { session } = await open();
		const reading = session.reload();
		expect(session.admitting).toBe(false);
		expect(session.set(withFields(session, { title: 'x' }))).toContain(
			'being read again',
		);
		expect(await reading).toBeUndefined();
		expect(session.set(withFields(session, { title: 'x' }))).toBeUndefined();
	});

	test('a reload after a failed save replaces the text and ends the failure', async () => {
		const { session, text, failWrites } = await open();
		failWrites();
		session.set(withFields(session, { title: 'Lost' }));
		await session.waitForSaves();
		failWrites(false);
		expect(await session.reload()).toBeUndefined();
		expect(session.save.status).toBe('idle');
		expect(session.row.text).toBe(noteText());
		expect(text(PATH)).toBe(noteText());
	});

	test('a reload that cannot read the file keeps the text and its failed save', async () => {
		const { session, put, drop, failWrites } = await open();
		failWrites();
		session.set(withFields(session, { title: 'Mine' }));
		await session.waitForSaves();
		const kept = session.row.text;
		put(PATH, new Uint8Array([0xff, 0xfe]));
		expect(await session.reload()).toContain('not UTF-8');
		expect(session.reloadError?.name).toBe('InvalidUtf8');
		expect(session.row.text).toBe(kept);
		expect(session.save.status).toBe('failed');
		drop(PATH);
		expect(await session.reload()).toContain('not in the folder');
		expect(session.missing).toBe(true);
		expect(session.row.text).toBe(kept);
		expect(session.save.status).toBe('failed');
	});
});

describe('input the row editor cannot take', () => {
	test('a title with an unpaired surrogate stays in its control with the reason, and is never submitted', async () => {
		const { session, text } = await open();
		const before = session.row.text;
		expect(typeTitle(session, 'a\uD800')).toContain('lone surrogate');
		expect(session.refused.title).toMatchObject({ value: 'a\uD800' });
		expect(session.refused.title?.reason).toContain('lone surrogate');
		expect(session.row.text).toBe(before);
		expect(session.status).toBe('dirty');
		expect(session.unsettled).toBe(true);
		// Nothing but the title control changes the title while it waits there.
		expect(session.set(withFields(session, { title: 'b' }))).toContain(
			'the title',
		);
		expect(session.showFile(true)).toContain('the title');
		// Other fields go on saving.
		expect(session.set(withFields(session, { pinned: true }))).toBeUndefined();
		await session.waitForSaves();
		expect(session.refused.title).toBeDefined();
		expect(typeTitle(session, 'a')).toBeUndefined();
		expect(session.refused.title).toBeUndefined();
		await session.waitForSaves();
		expect(text(PATH)).toBe(
			canonical(noteText(), { title: 'a', pinned: true }),
		);
	});

	test('a Source body the editor refuses stays in Source with the reason', async () => {
		const { session } = await open();
		expect(typeSource(session, 'Half \uD800\n')).toContain('lone surrogate');
		expect(session.refused.body?.value).toBe('Half \uD800\n');
		expect(typeSource(session, 'Whole\n')).toBeUndefined();
		expect(session.refused.body).toBeUndefined();
	});

	test('held typed text blocks only a document that changes its field, and the other fields go on saving', async () => {
		const { session, text } = await open();
		expect(typeTitle(session, 'a\uD800')).toContain('lone surrogate');
		expect(typeSource(session, 'Half \uD800\n')).toContain('lone surrogate');
		// A command that leaves the title and body as the editor holds them is taken.
		expect(
			session.set(withFields(session, { pinned: true, folderId: 'f' })),
		).toBeUndefined();
		// Each control changes its own field; the other's typed text stays.
		expect(typeSource(session, 'Typed\n')).toBeUndefined();
		expect(session.refused.body).toBeUndefined();
		expect(session.refused.title?.value).toBe('a\uD800');
		// A document from anywhere else that changes the waiting title is not.
		expect(session.set(withFields(session, { title: 'Other' }))).toContain(
			'the title',
		);
		await session.waitForSaves();
		expect(text(PATH)).toBe(
			canonical(
				noteText(),
				{ pinned: true, folderId: 'f', updatedAt: NOW },
				'Typed\n',
			),
		);
	});

	test('the accepted title typed again clears the title alone, and saves the same note', async () => {
		const { session, notes } = await open();
		expect(typeTitle(session, 'a\uD800')).toContain('lone surrogate');
		expect(typeSource(session, 'Half \uD800\n')).toContain('lone surrogate');
		const before = session.row.text;
		expect(typeTitle(session, 'A')).toBeUndefined();
		expect(session.refused.title).toBeUndefined();
		expect(session.refused.body?.value).toBe('Half \uD800\n');
		expect(session.row.text).toBe(before);
		expect(session.save.status).toBe('saving');
		await session.waitForSaves();
		expect(notes()).toBe(1);
	});
});

describe('the rich-text view', () => {
	test('its unchanged note is acknowledged with no save; any other unchanged note saves again', async () => {
		const { session, notes } = await open();
		const row = noteOf(session);
		expect(session.set(row, { control: 'rich' })).toBeUndefined();
		expect(session.save.status).toBe('idle');
		expect(notes()).toBe(0);
		// An equal document that is not the row itself is saved.
		expect(session.set({ ...row }, { control: 'rich' })).toBeUndefined();
		await session.waitForSaves();
		expect(notes()).toBe(1);
		expect(session.set(noteOf(session))).toBeUndefined();
		await session.waitForSaves();
		expect(notes()).toBe(2);
	});

	test('its unchanged note passes every gate first: Source holding typed text, a stopped rename, a fence', async () => {
		const { session, notes, fence } = await open();
		const unchanged = () => session.set(noteOf(session), { control: 'rich' });
		expect(typeSource(session, 'Half \uD800\n')).toContain('lone surrogate');
		expect(unchanged()).toContain('Markdown source');
		expect(typeSource(session, 'Body.\n')).toBeUndefined();
		await session.waitForSaves();
		const step = {
			kind: 'remove',
			from: { path: PATH, sha256: 'unknown' },
		} as const;
		session.track(step);
		session.conclude(step, { kind: 'unconfirmed', message: 'no reply' });
		expect(unchanged()).toContain('not finished');
		expect(session.detach()).toBe(true);
		expect(unchanged()).toContain('stopped tracking');
		expect(session.saveHere()).toBeUndefined();
		await session.waitForSaves();
		const saves = notes();
		fence();
		expect(unchanged()).toContain('closing');
		expect(notes()).toBe(saves);
	});

	test('a body the editor refuses from it is not kept as Source text', async () => {
		const { session } = await open();
		expect(
			session.set(withBody(noteOf(session), 'Half \uD800\n', NOW), {
				control: 'rich',
			}),
		).toContain('lone surrogate');
		expect(session.refused).toEqual({});
		expect(session.status).toBe('saved');
	});
});

describe('the file view', () => {
	test('a note that does not read as one opens the same editor, and its exact text repairs it', async () => {
		const broken = '---\ntitle: [open\n---\nHello\n';
		const { session, text } = await open(broken);
		expect(session.row).toMatchObject({ status: 'invalid', text: broken });
		expect(session.set({ fields: { title: 'x' }, body: '' })).toBe(
			'This note is not showing its fields.',
		);
		const fixed = noteText({ title: 'Fixed', extra: '# a comment\n' });
		expect(session.setText(fixed)).toBeUndefined();
		// The file view stays after the text reads as a note again.
		expect(session.rawMode).toBe(true);
		expect(session.row).toMatchObject({ status: 'valid' });
		await session.waitForSaves();
		expect(text(PATH)).toBe(fixed);
		expect(session.showFile(false)).toBeUndefined();
		expect(
			session.set(withFields(session, { title: 'Again' })),
		).toBeUndefined();
	});

	test('malformed text is saved as it is typed', async () => {
		const { session, text } = await open();
		session.showFile(true);
		session.setText('---\ntitle: [\n');
		await session.waitForSaves();
		expect(text(PATH)).toBe('---\ntitle: [\n');
		expect(session.showFile(false)).toContain('cannot be opened as a note yet');
	});
});

describe('fences and release', () => {
	test('while input is fenced nothing is taken, and flushing waits for a write already admitted', async () => {
		const { session, text, fence, hold, held, release } = await open();
		hold();
		session.set(withFields(session, { title: 'Typed' }));
		await until(() => held().length === 1, 'the write');
		fence();
		expect(session.set(withFields(session, { title: 'After' }))).toContain(
			'closing',
		);
		expect(session.retry()).toContain('closing');
		expect(await session.reload()).toContain('closing');
		let saved = false;
		void session.waitForSaves().then(() => {
			saved = true;
		});
		await settle();
		expect(saved).toBe(false);
		release({ all: true });
		await until(() => saved, 'the wait for saves');
		expect(text(PATH)).toBe(canonical(noteText(), { title: 'Typed' }));
	});

	test('work run with input fenced refuses every input and choice until it ends', async () => {
		const { session } = await open();
		await session.operate(async () => {
			expect(session.admitting).toBe(false);
			expect(session.canChoose).toBe(false);
			expect(session.set(withFields(session, { title: 'x' }))).toContain(
				'rename or delete',
			);
			expect(session.retry()).toContain('rename or delete');
			expect(await session.reload()).toContain('rename or delete');
		});
		expect(session.set(withFields(session, { title: 'x' }))).toBeUndefined();
	});

	test('a rename or delete that stopped short takes no typing, since every edit publishes', async () => {
		const { session, notes } = await open();
		const step = {
			kind: 'remove',
			from: { path: PATH, sha256: 'unknown' },
		} as const;
		session.track(step);
		session.conclude(step, { kind: 'unconfirmed', message: 'no reply' });
		expect(session.status).toBe('unconfirmed');
		expect(session.set(withFields(session, { title: 'x' }))).toContain(
			'not finished',
		);
		expect(await session.reload()).toContain('not finished');
		expect(session.detach()).toBe(true);
		expect(session.set(withFields(session, { title: 'x' }))).toContain(
			'stopped tracking',
		);
		expect(notes()).toBe(0);
		expect(session.saveHere()).toBeUndefined();
		expect(session.hold).toBeUndefined();
		await session.waitForSaves();
		expect(notes()).toBe(1);
		expect(session.set(withFields(session, { title: 'x' }))).toBeUndefined();
	});

	test('a released editor refuses everything for good, and a write it admitted still lands', async () => {
		const { session, text, hold, held, release } = await open();
		hold();
		session.set(withFields(session, { title: 'Admitted' }));
		await until(() => held().length === 1, 'the write');
		session.release();
		expect(session.set(withFields(session, { title: 'Late' }))).toBe(
			'This note was closed here.',
		);
		expect(session.setText('late')).toBe('This note was closed here.');
		expect(session.retry()).toBe('This note was closed here.');
		expect(await session.reload()).toBe('This note was closed here.');
		expect(session.admitting).toBe(false);
		release({ all: true });
		await until(
			() => text(PATH) === canonical(noteText(), { title: 'Admitted' }),
			'the admitted write',
		);
	});
});
