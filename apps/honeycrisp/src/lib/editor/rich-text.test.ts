/**
 * Rich Text Tests
 *
 * Drives the rich-text view's two rules the way the view does, over a real
 * row session on Honeycrisp's folder: each transaction goes through
 * `stateAfter` before it is shown, and the body is followed with
 * `stateShowing`. The state the harness keeps is what the view would display;
 * there is no other copy.
 *
 * Key behaviors:
 * - Every displayed edit is in the draft, including spaces, Enter, and
 *   Shift-Enter; the whole note is saved, with its fields
 * - Moving the cursor or setting pending formatting writes nothing, and is
 *   shown even while the session takes no input
 * - An edit Markdown cannot express, or made while the session takes no
 *   input, is refused before it is displayed
 * - A lone surrogate a file cannot hold is saved as U+FFFD, and the screen
 *   shows what was saved
 * - The same content keeps the state, its cursor, pending formatting, and
 *   undo history; different content replaces it; a body that is not rich
 *   text is never written over
 * - A transaction built before the body changed elsewhere is dropped
 */
import '../svelte-modules.test-support.js';
import { afterEach, describe, expect, test } from 'bun:test';
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
import { withBody } from '../note-source.js';
import { bodyCodec, equivalentNoteDocs, parseNoteBody } from './markdown.js';

// The rich-text rules save through an edit session, a runes module: load
// both after the compiler plugin.
const { createRowSession } = await import('@epicenter/svelte/edit-session');
const { editingPlugins, marks, nodes, stateAfter, stateShowing } = await import(
	'./rich-text.js'
);

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});

/** A row session over a note holding `text`, in a fresh folder. */
async function sessionOver(text: string) {
	const folder = await openNotesFolder();
	cleanup.push(folder.close);
	const path = 'notes/a.md';
	await folder.write(path, text);
	const stored = expectOk(await folder.folder.tables.notes.get('a'));
	if (stored === undefined) throw new Error('The note was not written');
	let locked = false;
	const session = createRowSession(folder.folder.tables.notes, stored, {
		locked: () => locked,
	});
	cleanup.push(async () => {
		session.release();
		await session.settled();
	});
	const attempts = () => folder.writes().filter((at) => at === path).length;
	const opened = attempts();
	return {
		folder,
		session,
		/** Write attempts at the note since its session opened. */
		writes: () => attempts() - opened,
		lock: (on = true) => {
			locked = on;
		},
	};
}

/** One rich-text view over `body`, as the view holds it, and its note. */
async function open(
	initialBody: string,
	{ text = noteText({ body: initialBody }) } = {},
) {
	const opened = await sessionOver(text);
	const { session } = opened;
	const body = () => session.draft.body;
	const initial = bodyCodec.decode(body());
	if (!initial.supported) throw new Error('The note is not rich text');
	/** Why the last edit was refused. */
	let refusal: string | undefined;
	/** What the view displays. */
	let state = EditorState.create({
		doc: initial.doc,
		plugins: editingPlugins(),
	});
	/** Deliver a transaction as the view does. Returns whether it was displayed. */
	const dispatch = (transaction: Transaction) => {
		const next = stateAfter(state, transaction, session, (reason) => {
			refusal = reason;
		});
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
		const now = bodyCodec.decode(body());
		if (now.supported) state = stateShowing(state, now.doc);
	};
	/** What the Source view does with typed text. */
	const source = (text: string) => session.edit((row) => withBody(row, text));
	/** What is on screen and what the draft holds are the same content. */
	const expectNoteHoldsScreen = () =>
		expect(equivalentNoteDocs(parseNoteBody(body()), state.doc)).toBe(true);
	return {
		...opened,
		source,
		/** The state the view displays now. */
		shown: () => state,
		refusal: () => refusal,
		dispatch,
		run,
		type,
		press,
		end,
		follow,
		body,
		expectNoteHoldsScreen,
	};
}

describe('every displayed edit is in the note', () => {
	test('a trailing space is kept, on screen and in the note', async () => {
		const { type, body, refusal, expectNoteHoldsScreen, ...view } =
			await open('');
		expect(type('A')).toBe(true);
		expect(type(' ')).toBe(true);
		expect(refusal()).toBeUndefined();
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
		const {
			type,
			press,
			body,
			session,
			end,
			writes,
			expectNoteHoldsScreen,
			...view
		} = await open('one\n');
		end();
		const before = JSON.parse(JSON.stringify(session.draft));
		press('Enter');
		expect(view.shown().doc.childCount).toBe(2);
		// An empty paragraph has no Markdown: the note, its time included, stays.
		expect(JSON.parse(JSON.stringify(session.draft))).toEqual(before);
		await session.settled();
		expect(writes()).toBe(0);
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
		const { type, press, body, follow, ...view } = await open('');
		type('a | b');
		press('Enter', { shift: true });
		type('|---|---|');
		expect(body()).toBe('a | b\\\n\\|---|---|\n');
		expect(bodyCodec.decode(body()).supported).toBe(true);
		const state = view.shown();
		follow();
		expect(view.shown()).toBe(state);
	});

	test('an edit saves the whole note once: the body, a new time, and every other field', async () => {
		const { type, session, folder } = await open('one\n');
		const before = JSON.parse(JSON.stringify(session.draft));
		type('x');
		const row = session.draft;
		expect(row.body).toBe('xone\n');
		expect(row.fields.updatedAt).not.toBe(before.fields.updatedAt);
		expect({ ...row.fields, updatedAt: undefined }).toEqual({
			...before.fields,
			updatedAt: undefined,
		});
		expect((await session.settled()).status).toBe('saved');
		const saved = folder.text('notes/a.md') ?? '';
		expect(saved).toContain('xone');
		// A key Honeycrisp does not declare is kept.
		expect(saved).toContain('owner');
	});

	test('CRLF line endings and blank lines at the start of the body are kept', async () => {
		const crlf = noteText({ body: '\none\n\ntwo\n' }).replace(/\n/g, '\r\n');
		const { type, end, body } = await open('', { text: crlf });
		end();
		type('!');
		expect(body()).toBe('\r\none\r\n\r\ntwo!\r\n');
	});

	test('moving the cursor or setting pending formatting writes nothing', async () => {
		const { end, run, body, writes, session, ...view } = await open('one\n');
		const before = body();
		end();
		expect(run(toggleMark(marks.em))).toBe(true);
		expect(view.shown().storedMarks?.map((mark) => mark.type)).toEqual([
			marks.em,
		]);
		expect(body()).toBe(before);
		await session.settled();
		expect(writes()).toBe(0);
	});

	test('moving the cursor is shown while the note takes no input, and writes nothing', async () => {
		const { end, lock, session, writes, ...view } = await open('one\n');
		lock();
		expect(end()).toBe(true);
		expect(view.shown().selection.head).toBe(4);
		await session.settled();
		expect(writes()).toBe(0);
	});
});

describe('an edit that cannot be written', () => {
	test('one Markdown cannot express is refused before it is displayed, and says why', async () => {
		const { run, body, refusal, ...view } = await open('a(b)\n');
		const before = view.shown();
		// Bold on "(b)" directly after a letter has no Markdown spelling.
		const displayed = run((state, send) => {
			send?.(state.tr.addMark(2, 5, marks.strong.create()));
			return true;
		});
		expect(displayed).toBe(false);
		expect(view.shown()).toBe(before);
		expect(body()).toBe('a(b)\n');
		expect(refusal()).toContain('cannot be written as Markdown');
	});

	test('a line break in a heading is refused; the heading text is untouched', async () => {
		const { run, body, ...view } = await open('# Title\n');
		const displayed = run((state, send) => {
			send?.(state.tr.insert(3, nodes.hard_break.create()));
			return true;
		});
		expect(displayed).toBe(false);
		expect(view.shown().doc.textContent).toBe('Title');
		expect(body()).toBe('# Title\n');
	});

	test('a lone surrogate is saved as U+FFFD, and the screen shows what was saved', async () => {
		const { dispatch, body, session, folder, expectNoteHoldsScreen, ...view } =
			await open('Body.\n');
		// Half of an emoji: Markdown can spell it, and a file cannot hold it.
		expect(dispatch(view.shown().tr.insertText('\uD800', 1))).toBe(true);
		expect(body()).toBe('\uFFFDBody.\n');
		expect(view.shown().doc.textContent).toBe('\uFFFDBody.');
		expectNoteHoldsScreen();
		expect((await session.settled()).status).toBe('saved');
		expect(folder.text('notes/a.md')).toContain('\uFFFDBody.');
	});

	test('one made while the session takes no input is not displayed, and editing goes on from the same history', async () => {
		const { type, run, lock, body, end, ...view } = await open('one\n');
		end();
		type('!');
		const state = view.shown();
		const depth = undoDepth(state);
		lock();
		expect(type('late')).toBe(false);
		expect(view.shown()).toBe(state);
		expect(body()).toBe('one!\n');
		lock(false);
		expect(type('?')).toBe(true);
		expect(body()).toBe('one!?\n');
		expect(undoDepth(view.shown())).toBeGreaterThanOrEqual(depth);
		while (undoDepth(view.shown()) > 0) run(undo);
		expect(body()).toBe('one\n');
	});

	test('Enter is not displayed while the session takes no input, and writes nothing', async () => {
		const { press, end, lock, session, writes, ...view } = await open('one\n');
		end();
		lock();
		const state = view.shown();
		press('Enter');
		expect(view.shown()).toBe(state);
		lock(false);
		press('Enter');
		expect(view.shown().doc.childCount).toBe(2);
		await session.settled();
		expect(writes()).toBe(0);
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
		source('_a_ b!\n');
		follow();
		expect(view.shown()).toBe(state);
		expect(view.shown().selection.head).toBe(5);
		expect(view.shown().storedMarks).not.toBeNull();
		expect(undoDepth(view.shown())).toBe(1);
	});

	test('a different body replaces the state without writing, and new edits are undoable', async () => {
		const { type, run, source, follow, body, end, ...view } =
			await open('one\n');
		end();
		type('!');
		source('from source\n');
		follow();
		expect(view.shown().doc.textContent).toBe('from source');
		expect(body()).toBe('from source\n');
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
		source('from source\n');
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
		source('from source\n');
		follow();
		const state = view.shown();
		expect(dispatch(late)).toBe(false);
		expect(dispatch(moved)).toBe(false);
		expect(view.shown()).toBe(state);
		expect(body()).toBe('from source\n');
	});

	test('a body that is not rich text is never written over', async () => {
		const { type, source, body, follow, ...view } = await open('one\n');
		const state = view.shown();
		source('<div>x</div>\n');
		expect(bodyCodec.decode(body()).supported).toBe(false);
		expect(type('x')).toBe(false);
		follow();
		expect(view.shown()).toBe(state);
		expect(body()).toBe('<div>x</div>\n');
	});

	test('HTML that reads as the same text as the document is still not rich text', async () => {
		const { type, source, body } = await open('');
		type('<b>x</b>');
		expect(body()).toBe('\\<b>x\\</b>\n');
		// Raw HTML parses to the same literal text, and the editor refuses it.
		source('<b>x</b>\n');
		const rich = bodyCodec.decode(body());
		expect(rich.supported).toBe(false);
		if (!rich.supported) expect(rich.reasons).toEqual(['It contains HTML.']);
		expect(type('!')).toBe(false);
		expect(body()).toBe('<b>x</b>\n');
	});
});
