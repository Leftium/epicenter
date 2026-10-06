/**
 * Rich Text Tests
 *
 * Drives the rich-text view's two rules the way the view does, over a real
 * note session on Honeycrisp's folder: each transaction goes through
 * `stateAfter` before it is shown, and the body is followed with
 * `stateShowing`. The state the harness keeps is what the view would display;
 * there is no other copy.
 *
 * Key behaviors:
 * - Every displayed edit is in the note, including spaces, Enter, and
 *   Shift-Enter; the whole note is written, with its fields
 * - Moving the cursor or setting pending formatting writes nothing
 * - An edit Markdown cannot express, or the note is not taking, is refused
 *   before it is displayed
 * - The same content keeps the state, its cursor, pending formatting, and
 *   undo history; different content replaces it; a body that is not rich
 *   text is never written over
 * - A transaction built before the body changed elsewhere is dropped
 */
import '../svelte-modules.test-support.js';
import { afterEach, describe, expect, test } from 'bun:test';
import type { InstantString } from '@epicenter/definition';
import { toggleMark } from 'prosemirror-commands';
import { redo, redoDepth, undo, undoDepth } from 'prosemirror-history';
import {
	type Command,
	EditorState,
	TextSelection,
	type Transaction,
} from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { expectOk } from 'wellcrafted/testing';
import { noteText, openNotesFolder } from '../folder.test-support.js';
import type { NoteSession } from '../note-session.svelte.js';
import { noteBody } from '../note-source.js';
import { equivalentNoteDocs, parseNoteBody } from './markdown.js';
import {
	editingPlugins,
	marks,
	nodes,
	stateAfter,
	stateShowing,
} from './rich-text.js';

const { createNoteSession } = await import('../note-session.svelte.ts');

const NOW = '2026-10-02T00:00:00.000Z' as InstantString;
const cleanup: (() => unknown)[] = [];

afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});

/** A note session over `text` at `stem`, in a fresh folder unless one is given. */
async function sessionOver(
	text: string,
	{
		stem = 'a',
		fixture,
	}: {
		stem?: string;
		fixture?: Awaited<ReturnType<typeof openNotesFolder>>;
	} = {},
) {
	const folder = fixture ?? (await openNotesFolder());
	if (fixture === undefined) cleanup.push(folder.close);
	const path = `notes/${stem}.md`;
	await folder.write(path, text);
	const editor = expectOk(await folder.folder.tables.notes.edit(stem));
	let admitting = true;
	const session = createNoteSession(editor, {
		path,
		admits: () => admitting,
	});
	cleanup.push(async () => {
		session.release();
		await session.waitForSaves();
	});
	return {
		folder,
		session,
		fence: (on = true) => {
			admitting = !on;
		},
	};
}

/** One rich-text view over `body`, as the view holds it, and its note. */
async function open(
	initialBody: string,
	{ text = noteText({ body: initialBody }) } = {},
) {
	const opened = await sessionOver(text);
	let current: NoteSession = opened.session;
	let mounted = true;
	const draft = noteBody(() => current, {
		mounted: () => mounted,
		now: () => NOW,
	});
	const source = noteBody(() => current, { keep: true });
	const initial = draft.rich;
	if (!initial.editable) throw new Error('The note is not rich text');
	/** What the view displays. */
	let state = EditorState.create({
		doc: initial.inspection.doc,
		plugins: editingPlugins(),
	});
	/** Deliver a transaction as the view does. Returns whether it was displayed. */
	const dispatch = (transaction: Transaction) => {
		const next = stateAfter(state, transaction, draft);
		if (next !== undefined) state = next;
		return next !== undefined;
	};
	const run = (command: Command) => {
		let displayed = false;
		command(state, (transaction) => {
			displayed = dispatch(transaction);
		});
		return displayed;
	};
	const type = (text: string) =>
		run((state, send) => {
			send?.(state.tr.insertText(text));
			return true;
		});
	/** A key, through the view's keymaps in order, as the view delivers it. */
	const press = (key: string, { shift = false } = {}) => {
		const event = {
			key,
			shiftKey: shift,
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			keyCode: 0,
		} as KeyboardEvent;
		const view = {
			get state() {
				return state;
			},
			dispatch,
		} as unknown as EditorView;
		const handled = state.plugins.some((plugin) =>
			plugin.props.handleKeyDown?.call(plugin, view, event),
		);
		if (!handled) throw new Error(`Nothing handles ${key}`);
	};
	const end = () =>
		run((state, send) => {
			send?.(state.tr.setSelection(TextSelection.atEnd(state.doc)));
			return true;
		});
	/** The view's effect after the body changed: show what the body holds now. */
	const follow = () => {
		const now = draft.rich;
		if (now.editable) state = stateShowing(state, now.inspection.doc);
	};
	const body = () => draft.body;
	/** What is on screen and what the note holds are the same content. */
	const expectNoteHoldsScreen = () =>
		expect(equivalentNoteDocs(parseNoteBody(body()), state.doc)).toBe(true);
	return {
		...opened,
		draft,
		source,
		/** The state the view displays now. */
		shown: () => state,
		dispatch,
		run,
		type,
		press,
		end,
		follow,
		body,
		expectNoteHoldsScreen,
		/** Hand the views to another session, as a rename does. */
		handTo(next: NoteSession) {
			current = next;
		},
		unmount() {
			mounted = false;
		},
	};
}

describe('every displayed edit is in the note', () => {
	test('a trailing space is kept, on screen and in the note', async () => {
		const { type, body, session, expectNoteHoldsScreen, ...view } =
			await open('');
		expect(type('A')).toBe(true);
		expect(type(' ')).toBe(true);
		expect(session.refusal).toBeUndefined();
		expect(view.shown().doc.textContent).toBe('A ');
		expect(body()).toBe('A&#32;\n');
		expect(parseNoteBody(body()).textContent).toBe('A ');
		expectNoteHoldsScreen();
		// The next letter makes the space ordinary again.
		type('b');
		expect(body()).toBe('A b\n');
	});

	test('leading spaces and tabs are kept', async () => {
		const { type, body, expectNoteHoldsScreen } = await open('');
		type('  ');
		type('\t');
		type('x');
		expect(parseNoteBody(body()).textContent).toBe('  \tx');
		expectNoteHoldsScreen();
	});

	test('Enter and Shift-Enter are displayed, and what Markdown cannot spell yet does not make the note newer', async () => {
		const { type, press, body, session, end, expectNoteHoldsScreen, ...view } =
			await open('one\n');
		end();
		const before = session.row.text;
		press('Enter');
		expect(view.shown().doc.childCount).toBe(2);
		// An empty paragraph has no Markdown: the note, its time included, stays.
		expect(session.row.text).toBe(before);
		expect(session.save.status).toBe('idle');
		expectNoteHoldsScreen();
		type('two');
		expect(body()).toBe('one\n\ntwo\n');
		press('Enter', { shift: true });
		expect(body()).toBe('one\n\ntwo\n');
		type('three');
		expect(body()).toBe('one\n\ntwo\\\nthree\n');
		expectNoteHoldsScreen();
	});

	test('a space typed in pending bold is kept', async () => {
		const { type, run, body, expectNoteHoldsScreen, ...view } = await open('');
		run(toggleMark(marks.strong));
		type('bold');
		type(' ');
		expect(view.shown().doc.textContent).toBe('bold ');
		expect(parseNoteBody(body()).textContent).toBe('bold ');
		expectNoteHoldsScreen();
		type('more');
		expect(body()).toBe('**bold more**\n');
	});

	test('typing Markdown syntax as text stays text', async () => {
		const { type, body, expectNoteHoldsScreen, ...view } = await open('');
		for (const character of '<b> &amp; 1) *x* __y__ #') type(character);
		expect(view.shown().doc.textContent).toBe('<b> &amp; 1) *x* __y__ #');
		expect(parseNoteBody(body()).textContent).toBe('<b> &amp; 1) *x* __y__ #');
		expectNoteHoldsScreen();
	});

	test('lines typed like a table stay text, and the note stays rich text', async () => {
		const { type, press, body, draft, follow, ...view } = await open('');
		type('a | b');
		press('Enter', { shift: true });
		type('|---|---|');
		expect(body()).toBe('a | b\\\n\\|---|---|\n');
		expect(draft.rich.editable).toBe(true);
		const state = view.shown();
		follow();
		expect(view.shown()).toBe(state);
	});

	test('an edit gives the editor the whole note once: the body, a new time, and every other field', async () => {
		const { type, session } = await open('one\n');
		const before = session.row;
		type('x');
		const row = session.row;
		if (row.status !== 'valid' || before.status !== 'valid')
			throw new Error('The note does not read');
		expect(row.body).toBe('xone\n');
		expect(row.fields.updatedAt).toBe(NOW);
		expect(row.text).toContain('"owner": {"name": "one", "tags": ["two"]}');
		expect({ ...row.fields, updatedAt: undefined }).toEqual({
			...before.fields,
			updatedAt: undefined,
		});
	});

	test('CRLF line endings and blank lines at the start of the body are kept', async () => {
		const crlf = noteText({ body: '\none\n\ntwo\n' }).replace(/\n/g, '\r\n');
		const { type, end, body } = await open('', { text: crlf });
		end();
		type('!');
		expect(body()).toBe('\r\none\r\n\r\ntwo!\r\n');
	});

	test('moving the cursor or setting pending formatting writes nothing', async () => {
		const { end, run, session, ...view } = await open('one\n');
		const before = session.row.text;
		end();
		expect(run(toggleMark(marks.em))).toBe(true);
		expect(view.shown().storedMarks?.map((mark) => mark.type)).toEqual([
			marks.em,
		]);
		expect(session.row.text).toBe(before);
		expect(session.save.status).toBe('idle');
	});
});

describe('an edit that cannot be written', () => {
	test('one Markdown cannot express is refused before it is displayed, and says why', async () => {
		const { run, session, ...view } = await open('a(b)\n');
		const before = view.shown();
		const text = session.row.text;
		// Bold on "(b)" directly after a letter has no Markdown spelling.
		const displayed = run((state, send) => {
			send?.(state.tr.addMark(2, 5, marks.strong.create()));
			return true;
		});
		expect(displayed).toBe(false);
		expect(view.shown()).toBe(before);
		expect(session.row.text).toBe(text);
		expect(session.refusal).toContain('cannot be written as Markdown');
	});

	test('a line break in a heading is refused; the heading text is untouched', async () => {
		const { run, session, ...view } = await open('# Title\n');
		const displayed = run((state, send) => {
			send?.(state.tr.insert(3, nodes.hard_break.create()));
			return true;
		});
		expect(displayed).toBe(false);
		expect(view.shown().doc.textContent).toBe('Title');
		expect(session.save.status).toBe('idle');
	});

	test('one the editor refuses is not displayed, and the undo history stays as it was', async () => {
		const { dispatch, session, ...view } = await open('Body.\n');
		const before = view.shown();
		// Half of an emoji: Markdown can spell it, and a file cannot hold it.
		expect(dispatch(view.shown().tr.insertText('\uD800', 1))).toBe(false);
		expect(view.shown()).toBe(before);
		expect(undoDepth(view.shown())).toBe(0);
		expect(session.refusal).toContain('lone surrogate');
		expect(session.refused.body).toBeUndefined();
		expect(session.save.status).toBe('idle');
		// The next edit it can take is shown and kept in its history.
		expect(dispatch(view.shown().tr.insertText('ok ', 1))).toBe(true);
		expect(undoDepth(view.shown())).toBe(1);
	});

	test('one made while the note is fenced is not displayed, and editing goes on from the same history', async () => {
		const { type, run, fence, body, end, ...view } = await open('one\n');
		end();
		type('!');
		const state = view.shown();
		const depth = undoDepth(state);
		fence();
		expect(type('late')).toBe(false);
		expect(view.shown()).toBe(state);
		expect(body()).toBe('one!\n');
		fence(false);
		expect(type('?')).toBe(true);
		expect(body()).toBe('one!?\n');
		expect(undoDepth(view.shown())).toBeGreaterThanOrEqual(depth);
		while (undoDepth(view.shown()) > 0) run(undo);
		expect(body()).toBe('one\n');
	});

	test('rich text does not write over a Source body the editor refused', async () => {
		const { source, dispatch, session, ...view } = await open('Body.\n');
		expect(source.input('Half \uD800\n')).toBe(false);
		expect(session.refused.body?.value).toBe('Half \uD800\n');
		expect(dispatch(view.shown().tr.insertText('x', 1))).toBe(false);
		expect(session.refusal).toContain('Markdown source');
		expect(session.refused.body?.value).toBe('Half \uD800\n');
	});

	test('one from a view that is gone is not taken', async () => {
		const { type, unmount, session, body } = await open('one\n');
		unmount();
		expect(type('late')).toBe(false);
		expect(body()).toBe('one\n');
		expect(session.save.status).toBe('idle');
	});
});

describe('undo history', () => {
	test('lasts across edits: the state is one continuous history', async () => {
		const { type, press, run, body, end, expectNoteHoldsScreen, ...view } =
			await open('one\n');
		end();
		type(' two');
		press('Enter');
		type('three');
		expect(undoDepth(view.shown())).toBeGreaterThan(0);
		while (undoDepth(view.shown()) > 0) expect(run(undo)).toBe(true);
		expect(view.shown().doc.textContent).toBe('one');
		expect(body()).toBe('one\n');
		expectNoteHoldsScreen();
		while (redoDepth(view.shown()) > 0) expect(run(redo)).toBe(true);
		expect(body()).toBe('one two\n\nthree\n');
	});

	test('a body this view wrote, or a look at Source that changes nothing, keeps the state', async () => {
		const { type, press, end, follow, ...view } = await open('one\n');
		end();
		type('!');
		press('Enter');
		const state = view.shown();
		follow();
		expect(view.shown()).toBe(state);
		// The empty paragraph Enter made is still there to type into.
		expect(view.shown().doc.childCount).toBe(2);
		expect(undoDepth(view.shown())).toBeGreaterThan(0);
	});

	test('the same content respelled in Source keeps the cursor, pending formatting, and history', async () => {
		const { type, run, source, follow, body, ...view } = await open('*a* b\n');
		run((state, send) => {
			send?.(state.tr.setSelection(TextSelection.create(state.doc, 4)));
			return true;
		});
		type('!');
		run(toggleMark(marks.strong));
		const state = view.shown();
		expect(body()).toBe('*a* b!\n');
		expect(source.input('_a_ b!\n')).toBe(true);
		follow();
		expect(view.shown()).toBe(state);
		expect(view.shown().selection.head).toBe(5);
		expect(view.shown().storedMarks).not.toBeNull();
		expect(undoDepth(view.shown())).toBe(1);
	});

	test('a different body replaces the state without writing, and new edits are undoable', async () => {
		const { type, run, source, follow, session, body, end, ...view } =
			await open('one\n');
		end();
		type('!');
		expect(source.input('from source\n')).toBe(true);
		const text = session.row.text;
		follow();
		expect(view.shown().doc.textContent).toBe('from source');
		expect(session.row.text).toBe(text);
		expect(undoDepth(view.shown())).toBe(0);
		// The cursor starts at the start.
		expect(view.shown().selection.head).toBe(1);
		// Undo does not bring back text from before the replacement.
		run(undo);
		expect(body()).toBe('from source\n');
		end();
		type('?');
		expect(body()).toBe('from source?\n');
		run(undo);
		expect(body()).toBe('from source\n');
	});
});

describe('a body that changed elsewhere', () => {
	test('a transaction that arrives before the view followed is dropped, and the body is shown', async () => {
		const { type, source, body, follow, ...view } = await open('one\n');
		// Source took a body; the view has not followed it yet.
		expect(source.input('from source\n')).toBe(true);
		expect(type('x')).toBe(true);
		expect(view.shown().doc.textContent).toBe('from source');
		expect(body()).toBe('from source\n');
		expect(undoDepth(view.shown())).toBe(0);
		const state = view.shown();
		follow();
		expect(view.shown()).toBe(state);
	});

	test('a transaction built before a replacement is dropped after it', async () => {
		const { dispatch, source, body, follow, ...view } = await open('one\n');
		const late = view.shown().tr.insertText('late ', 1);
		const moved = view
			.shown()
			.tr.setSelection(TextSelection.create(view.shown().doc, 4));
		expect(source.input('from source\n')).toBe(true);
		follow();
		const state = view.shown();
		expect(dispatch(late)).toBe(false);
		expect(dispatch(moved)).toBe(false);
		expect(view.shown()).toBe(state);
		expect(body()).toBe('from source\n');
	});

	test('a body that is not rich text is never written over', async () => {
		const { type, source, body, draft, follow, ...view } = await open('one\n');
		const state = view.shown();
		expect(source.input('<div>x</div>\n')).toBe(true);
		expect(draft.rich.editable).toBe(false);
		expect(type('x')).toBe(false);
		follow();
		expect(view.shown()).toBe(state);
		expect(body()).toBe('<div>x</div>\n');
	});

	test('HTML that reads as the same text as the document is still not rich text', async () => {
		const { type, source, body, draft } = await open('');
		type('<b>x</b>');
		expect(body()).toBe('\\<b>x\\</b>\n');
		// Raw HTML parses to the same literal text, and the editor refuses it.
		expect(source.input('<b>x</b>\n')).toBe(true);
		const rich = draft.rich;
		expect(rich.editable).toBe(false);
		if (!rich.editable) expect(rich.reasons).toEqual(['It contains HTML.']);
		expect(type('!')).toBe(false);
		expect(body()).toBe('<b>x</b>\n');
	});
});

describe('a rename hands the note to a new session', () => {
	test('the same state and history write to the session that holds the note now', async () => {
		const { type, end, follow, handTo, folder, session, ...view } =
			await open('one\n');
		end();
		type('!');
		const renamed = await sessionOver(noteText({ body: 'one!\n' }), {
			stem: 'b',
			fixture: folder,
		});
		handTo(renamed.session);
		const state = view.shown();
		follow();
		expect(view.shown()).toBe(state);
		type('?');
		expect(renamed.session.row).toMatchObject({ body: 'one!?\n' });
		expect(session.row).toMatchObject({ body: 'one!\n' });
		expect(undoDepth(view.shown())).toBeGreaterThan(0);
	});
});
