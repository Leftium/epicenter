/**
 * Note Session Tests
 *
 * Drives one note session, the app's policy around the folder's row editor,
 * over Honeycrisp's real browser folder on the in-memory OPFS stand-in. The
 * editor is the production `table.edit`; a write is held, failed, or loses
 * its reply at the stand-in's file streams, and another program's writes and
 * removals go below the folder's API.
 *
 * Key behaviors:
 * - Opening writes nothing; an edit gives the editor the complete note at
 *   once, unknown keys included, and a field left out is removed
 * - Typing during a held write saves only the latest input next, with no
 *   idle moment between the two writes
 * - A failed or unconfirmed write keeps the text editable; typing afterwards
 *   saves nothing until the person's Try again
 * - Another program's change leaves the open text alone until the person
 *   reloads; a reload that fails keeps the text and its save state
 * - Typed text the editor refuses stays in its own control with the reason,
 *   and a refused rich-text transaction changes nothing
 * - Fences and release refuse input; flushing waits for admitted writes
 */
import './svelte-modules.test-support.js';
import { afterEach, describe, expect, test } from 'bun:test';
import {
	formatCanonicalDocument,
	parseCanonicalDocument,
} from '@epicenter/folder';
import { undoDepth } from 'prosemirror-history';
import { expectOk } from 'wellcrafted/testing';
import { honeycrispDefinition } from './data.js';
import { createRichSession } from './editor/rich-session.js';
import {
	noteText,
	openNotesFolder,
	settle,
	until,
} from './folder.test-support.js';
import type { NoteSession } from './note-session.svelte.js';
import { noteBody } from './note-source.js';

const { createNoteSession, noteSaveProblem } = await import(
	'./note-session.svelte.ts'
);

const PATH = 'notes/a.md';
const DECLARED = Object.keys(honeycrispDefinition.tables.notes.fields);
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
	const session = createNoteSession(editor, {
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
function fieldsOf(session: NoteSession) {
	const { row } = session;
	if (row.status !== 'valid') throw new Error('The note does not read');
	return row.fields;
}

describe('typing and saving', () => {
	test('opening writes nothing; an edit gives the editor the complete note at once, unknown keys kept', async () => {
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

		expect(session.edit({ fields: { title: 'Typed' } })).toBeUndefined();
		const saved = canonical(hand, { title: 'Typed' });
		// The editor holds it now; there is no draft beside it.
		expect(session.row.text).toBe(saved);
		expect(session.save.status).toBe('saving');
		expect((await session.flush()).error).toBeNull();
		expect(text(PATH)).toBe(saved);
		expect(saved).toContain('"owner": {"name": "one", "tags": ["two"]}');
		expect(saved).not.toContain('# kept');
		expect(saved.endsWith('---\nKeep this body.\n')).toBe(true);
		expect(session.status).toBe('saved');
		expect(session.unsettled).toBe(false);
	});

	test('a body typed in the rich text or Source moves updatedAt in the same edit', async () => {
		const { session, text } = await open();
		const body = noteBody(() => session, {
			now: () => '2026-10-02T00:00:00.000Z' as never,
		});
		expect(body.input('New body.\n')).toBe(true);
		expect(body.body).toBe('New body.\n');
		await session.flush();
		expect(text(PATH)).toBe(
			canonical(
				noteText(),
				{ updatedAt: '2026-10-02T00:00:00.000Z' },
				'New body.\n',
			),
		);
	});

	test('a body from a view that is gone is not taken', async () => {
		const { session, notes } = await open();
		let mounted = true;
		const body = noteBody(() => session, { mounted: () => mounted });
		mounted = false;
		expect(body.input('Late.\n')).toBe(false);
		expect(session.save.status).toBe('idle');
		expect(notes()).toBe(0);
	});

	test('typing during a held write saves only the latest input next, with no idle moment', async () => {
		const { session, text, hold, held, release, saves } = await open();
		hold();
		session.edit({ fields: { title: 'First' } });
		await until(() => held().length === 1, 'the first write to wait');
		session.edit({ fields: { title: 'Second' } });
		session.edit({ fields: { title: 'Third' } });
		expect(fieldsOf(session).title).toBe('Third');
		release();
		await until(() => held().length === 1, 'the next write to wait');
		expect(text(PATH)).toBe(canonical(noteText(), { title: 'First' }));
		expect(session.save.status).toBe('saving');
		release({ all: true });
		expect((await session.flush()).error).toBeNull();
		// "Second" was superseded before it was attempted.
		expect(text(PATH)).toBe(canonical(noteText(), { title: 'Third' }));
		expect(saves).toEqual(['saving', 'idle']);
	});

	test('a field left out is removed, and text that no longer reads as a note is saved all the same', async () => {
		const { session, text } = await open();
		expect(session.edit({ fields: { deletedAt: undefined } })).toBeUndefined();
		// Whole validity decides which view shows; the fields give way to the file.
		expect(session.row.status).toBe('invalid');
		await session.flush();
		expect(text(PATH)).not.toContain('deletedAt');
		expect(text(PATH)).toContain('"owner"');
	});
});

describe('a write that does not end saved', () => {
	test('a failed write keeps the text editable, typing afterwards saves nothing, and only Try again saves', async () => {
		const { session, text, failWrites, saves, notes } = await open();
		failWrites();
		session.edit({ fields: { title: 'Lost?' } });
		const { error } = await session.flush();
		expect(error?.name).toBe('Io');
		expect(session.save).toMatchObject({
			status: 'failed',
			error: { name: 'Io' },
		});
		expect(session.status).toBe('failed');
		expect(session.unsettled).toBe(true);
		const attempts = notes();
		// The text stays editable; nothing is attempted.
		expect(session.edit({ fields: { title: 'Newer' } })).toBeUndefined();
		await settle();
		expect(fieldsOf(session).title).toBe('Newer');
		expect(notes()).toBe(attempts);
		expect(saves).toEqual(['saving', 'failed']);
		expect(text(PATH)).toBe(noteText());
		// Waiting for the chain never tries again either.
		expect((await session.flush()).error?.name).toBe('Io');
		expect(notes()).toBe(attempts);
		failWrites(false);
		expect(session.retry()).toBeUndefined();
		expect((await session.flush()).error).toBeNull();
		expect(text(PATH)).toBe(canonical(noteText(), { title: 'Newer' }));
		expect(session.status).toBe('saved');
	});

	test('an unconfirmed write is uncertainty in the folder’s own words, and Save again is a new attempt', async () => {
		const { session, text, loseReplies } = await open();
		loseReplies();
		session.edit({ fields: { title: 'Maybe' } });
		await session.flush();
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
		await session.flush();
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
		await session.flush();
		expect(session.save.status).toBe('failed');
		failWrites(false);
		expect(session.retry()).toBeUndefined();
		await session.flush();
		expect(text(PATH)).toBe(hand);
	});

	test('a deleted file fails the next save with the text kept editable, and nothing writes it back', async () => {
		const { session, text, drop } = await open();
		drop(PATH);
		session.edit({ fields: { title: 'Mine' } });
		expect((await session.flush()).error?.name).toBe('NotFound');
		expect(session.missing).toBe(true);
		expect(fieldsOf(session).title).toBe('Mine');
		expect(session.edit({ fields: { title: 'More' } })).toBeUndefined();
		session.retry();
		expect((await session.flush()).error?.name).toBe('NotFound');
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
		session.edit({ fields: { title: 'Mine' } });
		await session.flush();
		expect(text(PATH)).toBe(canonical(noteText(), { title: 'Mine' }));
	});

	test('a reload takes no input while it reads', async () => {
		const { session } = await open();
		const reading = session.reload();
		expect(session.admitting).toBe(false);
		expect(session.edit({ fields: { title: 'x' } })).toContain(
			'being read again',
		);
		expect(await reading).toBeUndefined();
		expect(session.edit({ fields: { title: 'x' } })).toBeUndefined();
	});

	test('a reload after a failed save replaces the text and ends the failure', async () => {
		const { session, text, failWrites } = await open();
		failWrites();
		session.edit({ fields: { title: 'Lost' } });
		await session.flush();
		failWrites(false);
		expect(await session.reload()).toBeUndefined();
		expect(session.save.status).toBe('idle');
		expect(session.row.text).toBe(noteText());
		expect(text(PATH)).toBe(noteText());
	});

	test('a reload that cannot read the file keeps the text and its failed save', async () => {
		const { session, put, drop, failWrites } = await open();
		failWrites();
		session.edit({ fields: { title: 'Mine' } });
		await session.flush();
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
		expect(
			session.edit({ fields: { title: 'a\uD800' } }, { keep: true }),
		).toContain('lone surrogate');
		expect(session.refused.title).toMatchObject({ value: 'a\uD800' });
		expect(session.refused.title?.reason).toContain('lone surrogate');
		expect(session.row.text).toBe(before);
		expect(session.status).toBe('dirty');
		expect(session.unsettled).toBe(true);
		// Nothing but the title control changes the title while it waits there.
		expect(session.edit({ fields: { title: 'b' } })).toContain('the title');
		expect(session.showFile(true)).toContain('the title');
		// Other fields go on saving.
		expect(session.edit({ fields: { pinned: true } })).toBeUndefined();
		await session.flush();
		expect(session.refused.title).toBeDefined();
		expect(
			session.edit({ fields: { title: 'a' } }, { keep: true }),
		).toBeUndefined();
		expect(session.refused.title).toBeUndefined();
		await session.flush();
		expect(text(PATH)).toBe(
			canonical(noteText(), { title: 'a', pinned: true }),
		);
	});

	test('a rich-text edit the editor refuses is not shown, and its undo history stays as it was', async () => {
		const { session } = await open();
		const rich = createRichSession(noteBody(() => session));
		if (rich === undefined) throw new Error('The note is not rich text');
		const before = rich.state;
		// Half of an emoji: Markdown can spell it, and a file cannot hold it.
		expect(rich.apply(rich.state.tr.insertText('\uD800', 1))).toBeUndefined();
		expect(rich.state).toBe(before);
		expect(undoDepth(rich.state)).toBe(0);
		expect(session.refusal).toContain('lone surrogate');
		expect(session.refused.body).toBeUndefined();
		expect(session.save.status).toBe('idle');
		// The next edit it can take is shown and kept in its history.
		expect(rich.apply(rich.state.tr.insertText('ok ', 1))).toBeDefined();
		expect(undoDepth(rich.state)).toBe(1);
		expect(rich.sync()).toBeUndefined();
	});

	test('a Source body the editor refuses stays in Source, and rich text does not write over it', async () => {
		const { session } = await open();
		const source = noteBody(() => session, { keep: true });
		const rich = createRichSession(noteBody(() => session));
		if (rich === undefined) throw new Error('The note is not rich text');
		expect(source.input('Half \uD800\n')).toBe(false);
		expect(session.refused.body?.value).toBe('Half \uD800\n');
		expect(rich.apply(rich.state.tr.insertText('x', 1))).toBeUndefined();
		expect(session.refusal).toContain('Markdown source');
		expect(source.input('Whole\n')).toBe(true);
		expect(session.refused.body).toBeUndefined();
	});
});

describe('the file view', () => {
	test('a note that does not read as one opens the same editor, and its exact text repairs it', async () => {
		const broken = '---\ntitle: [open\n---\nHello\n';
		const { session, text } = await open(broken);
		expect(session.row).toMatchObject({ status: 'invalid', text: broken });
		expect(session.edit({ fields: { title: 'x' } })).toBe(
			'This note is not showing its fields.',
		);
		const fixed = noteText({ title: 'Fixed', extra: '# a comment\n' });
		expect(session.setText(fixed)).toBeUndefined();
		// The file view stays after the text reads as a note again.
		expect(session.rawMode).toBe(true);
		expect(session.row).toMatchObject({ status: 'valid' });
		await session.flush();
		expect(text(PATH)).toBe(fixed);
		expect(session.showFile(false)).toBeUndefined();
		expect(session.edit({ fields: { title: 'Again' } })).toBeUndefined();
	});

	test('malformed text is saved as it is typed', async () => {
		const { session, text } = await open();
		session.showFile(true);
		session.setText('---\ntitle: [\n');
		await session.flush();
		expect(text(PATH)).toBe('---\ntitle: [\n');
		expect(session.showFile(false)).toContain('cannot be opened as a note yet');
	});
});

describe('fences and release', () => {
	test('while input is fenced nothing is taken, and flushing waits for a write already admitted', async () => {
		const { session, text, fence, hold, held, release } = await open();
		hold();
		session.edit({ fields: { title: 'Typed' } });
		await until(() => held().length === 1, 'the write');
		fence();
		expect(session.edit({ fields: { title: 'After' } })).toContain('closing');
		expect(session.retry()).toContain('closing');
		expect(await session.reload()).toContain('closing');
		let flushed = false;
		void session.flush().then(() => {
			flushed = true;
		});
		await settle();
		expect(flushed).toBe(false);
		release({ all: true });
		await until(() => flushed, 'the flush');
		expect(text(PATH)).toBe(canonical(noteText(), { title: 'Typed' }));
	});

	test('work run with input fenced refuses every input and choice until it ends', async () => {
		const { session } = await open();
		await session.operate(async () => {
			expect(session.admitting).toBe(false);
			expect(session.canChoose).toBe(false);
			expect(session.edit({ fields: { title: 'x' } })).toContain(
				'rename or delete',
			);
			expect(session.retry()).toContain('rename or delete');
			expect(await session.reload()).toContain('rename or delete');
		});
		expect(session.edit({ fields: { title: 'x' } })).toBeUndefined();
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
		expect(session.edit({ fields: { title: 'x' } })).toContain('not finished');
		expect(await session.reload()).toContain('not finished');
		expect(session.detach()).toBe(true);
		expect(session.edit({ fields: { title: 'x' } })).toContain(
			'stopped tracking',
		);
		expect(notes()).toBe(0);
		expect(session.saveHere()).toBeUndefined();
		expect(session.hold).toBeUndefined();
		await session.flush();
		expect(notes()).toBe(1);
		expect(session.edit({ fields: { title: 'x' } })).toBeUndefined();
	});

	test('a released session refuses everything for good, and a write it admitted still lands', async () => {
		const { session, text, hold, held, release } = await open();
		hold();
		session.edit({ fields: { title: 'Admitted' } });
		await until(() => held().length === 1, 'the write');
		session.release();
		expect(session.edit({ fields: { title: 'Late' } })).toBe(
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
