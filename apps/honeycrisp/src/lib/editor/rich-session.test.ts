/**
 * Rich Session Tests
 *
 * Drives the rich-text session the way the view does: transactions in,
 * states out, against a draft. The session has no DOM, so undo history,
 * refusals, and the tie to the draft are tested exactly as they run.
 *
 * Key behaviors:
 * - Every displayed edit is in the draft, including spaces and Enter
 * - An edit Markdown cannot express, or the draft is not taking, is refused
 *   before it is displayed
 * - Undo history lasts across edits and across a look at Source
 * - A body changed elsewhere replaces the document and resets history
 * - Moving the cursor writes nothing
 */
import { describe, expect, test } from 'bun:test';
import type { InstantString } from '@epicenter/definition';
import { readSource } from '@epicenter/folder';
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { redo, redoDepth, undo, undoDepth } from 'prosemirror-history';
import { type Command, TextSelection } from 'prosemirror-state';
import { equivalentNoteDocs, parseNoteBody } from './markdown.js';
import {
	createRichSession,
	marks,
	nodes,
	type RichSession,
} from './rich-session.js';

const NOW = '2026-10-02T00:00:00.000Z' as InstantString;
const HEAD =
	'---\ntitle: T\n# kept\nextra: 1\nupdatedAt: 2026-10-01T00:00:00.000Z\n---\n';

function draftOf(source: string) {
	const draft = {
		buffer: source,
		inputs: 0,
		refusal: undefined as string | undefined,
		/** Whether input is being taken, as it is not while the app closes. */
		admits: true,
		input(text: string) {
			if (!draft.admits) return false;
			draft.buffer = text;
			draft.inputs += 1;
			draft.refusal = undefined;
			return true;
		},
		refuse(reason: string) {
			draft.refusal = reason;
		},
	};
	return draft;
}

function open(initialBody: string) {
	const draft = draftOf(HEAD + initialBody);
	const session = createRichSession(draft, { now: () => NOW }) as RichSession;
	expect(session).toBeDefined();
	/** Run a command the way the view does. Returns whether it was displayed. */
	const run = (command: Command) => {
		let displayed = false;
		command(session.state, (transaction) => {
			displayed = session.apply(transaction) !== undefined;
		});
		return displayed;
	};
	const type = (text: string) =>
		run((state, dispatch) => {
			dispatch?.(state.tr.insertText(text));
			return true;
		});
	const body = () => readSource(draft.buffer).body as string;
	/** What is on screen and what the draft holds are the same content. */
	const expectDraftHoldsScreen = () =>
		expect(equivalentNoteDocs(parseNoteBody(body()), session.state.doc)).toBe(
			true,
		);
	const end = () =>
		run((state, dispatch) => {
			dispatch?.(state.tr.setSelection(TextSelection.atEnd(state.doc)));
			return true;
		});
	return { draft, session, run, type, body, expectDraftHoldsScreen, end };
}

describe('every displayed edit is in the draft', () => {
	test('a trailing space is kept, on screen and in the draft', () => {
		const { type, body, session, draft, expectDraftHoldsScreen } = open('');
		expect(type('A')).toBe(true);
		expect(type(' ')).toBe(true);
		expect(draft.refusal).toBeUndefined();
		expect(session.state.doc.textContent).toBe('A ');
		expect(body()).toBe('A&#32;\n');
		expect(parseNoteBody(body()).textContent).toBe('A ');
		expectDraftHoldsScreen();
		// The next letter makes the space ordinary again.
		type('b');
		expect(body()).toBe('A b\n');
	});

	test('leading spaces and tabs are kept', () => {
		const { type, body, expectDraftHoldsScreen } = open('');
		type('  ');
		type('\t');
		type('x');
		expect(parseNoteBody(body()).textContent).toBe('  \tx');
		expectDraftHoldsScreen();
	});

	test('Enter is displayed, and the new empty paragraph does not make the note newer', () => {
		const { type, run, body, session, draft, end, expectDraftHoldsScreen } =
			open('one\n');
		end();
		const before = draft.buffer;
		expect(run(baseKeymap.Enter as Command)).toBe(true);
		expect(session.state.doc.childCount).toBe(2);
		expect(draft.buffer).toBe(before);
		expect(draft.refusal).toBeUndefined();
		expectDraftHoldsScreen();
		type('two');
		expect(body()).toBe('one\n\ntwo\n');
		expectDraftHoldsScreen();
	});

	test('a space typed in bold is kept', () => {
		const { type, run, body, session, expectDraftHoldsScreen } = open('');
		run(toggleMark(marks.strong));
		type('bold');
		type(' ');
		expect(session.state.doc.textContent).toBe('bold ');
		expect(parseNoteBody(body()).textContent).toBe('bold ');
		expectDraftHoldsScreen();
		type('more');
		expect(body()).toBe('**bold more**\n');
	});

	test('typing Markdown syntax as text stays text', () => {
		const { type, body, session, expectDraftHoldsScreen } = open('');
		for (const character of '<b> &amp; 1) *x* __y__ #') type(character);
		expect(session.state.doc.textContent).toBe('<b> &amp; 1) *x* __y__ #');
		expect(parseNoteBody(body()).textContent).toBe('<b> &amp; 1) *x* __y__ #');
		expectDraftHoldsScreen();
	});

	test('an edit changes only the body and updatedAt', () => {
		const { type, draft } = open('one\n');
		type('x');
		expect(draft.buffer).toBe(
			`${HEAD.replace('2026-10-01', '2026-10-02')}xone\n`,
		);
	});

	test('moving the cursor writes nothing', () => {
		const { end, draft } = open('one\n');
		end();
		expect(draft.inputs).toBe(0);
		expect(draft.buffer).toBe(`${HEAD}one\n`);
	});
});

describe('an edit Markdown cannot express', () => {
	test('is refused before it is displayed, and says why', () => {
		const { run, session, draft } = open('a(b)\n');
		const before = session.state;
		const buffer = draft.buffer;
		// Bold on "(b)" directly after a letter has no Markdown spelling.
		const displayed = run((state, dispatch) => {
			dispatch?.(state.tr.addMark(2, 5, marks.strong.create()));
			return true;
		});
		expect(displayed).toBe(false);
		expect(session.state).toBe(before);
		expect(draft.buffer).toBe(buffer);
		expect(draft.refusal).toContain('cannot be written as Markdown');
	});

	test('an edit the draft is not taking is not displayed, and editing continues from the same history afterwards', () => {
		const { type, run, session, draft, body, end } = open('one\n');
		end();
		type('!');
		const state = session.state;
		const depth = undoDepth(state);
		draft.admits = false;
		expect(type('late')).toBe(false);
		expect(session.state).toBe(state);
		expect(body()).toBe('one!\n');
		draft.admits = true;
		expect(type('?')).toBe(true);
		expect(body()).toBe('one!?\n');
		expect(undoDepth(session.state)).toBeGreaterThanOrEqual(depth);
		while (undoDepth(session.state) > 0) run(undo);
		expect(body()).toBe('one\n');
	});

	test('a line break in a heading is refused; the heading text is untouched', () => {
		const { run, session, draft } = open('# Title\n');
		const displayed = run((state, dispatch) => {
			dispatch?.(state.tr.insert(3, nodes.hard_break.create()));
			return true;
		});
		expect(displayed).toBe(false);
		expect(session.state.doc.textContent).toBe('Title');
		expect(draft.inputs).toBe(0);
	});
});

describe('undo history', () => {
	test('lasts across edits: the state is one continuous session', () => {
		const { type, run, body, session, end, expectDraftHoldsScreen } =
			open('one\n');
		end();
		type(' two');
		run(baseKeymap.Enter as Command);
		type('three');
		expect(undoDepth(session.state)).toBeGreaterThan(0);
		while (undoDepth(session.state) > 0) expect(run(undo)).toBe(true);
		expect(session.state.doc.textContent).toBe('one');
		expect(body()).toBe('one\n');
		expectDraftHoldsScreen();
		while (redoDepth(session.state) > 0) expect(run(redo)).toBe(true);
		expect(body()).toBe('one two\n\nthree\n');
	});

	test('survives a look at Source that changes nothing', () => {
		const { type, session, end } = open('one\n');
		end();
		type('!');
		const depth = undoDepth(session.state);
		const state = session.state;
		// Switching to Source and back calls sync with the draft unchanged.
		expect(session.sync()).toBeUndefined();
		expect(session.state).toBe(state);
		expect(undoDepth(session.state)).toBe(depth);
	});

	test('is reset when Source changed the body, and new edits are undoable', () => {
		const { type, run, draft, session, body, end } = open('one\n');
		end();
		type('!');
		draft.input(`${HEAD}from source\n`);
		const replaced = session.sync();
		expect(replaced).toBeDefined();
		expect(session.state.doc.textContent).toBe('from source');
		expect(undoDepth(session.state)).toBe(0);
		// Undo does not bring back text from before the replacement.
		run(undo);
		expect(body()).toBe('from source\n');
		end();
		type('?');
		expect(body()).toBe('from source?\n');
		run(undo);
		expect(body()).toBe('from source\n');
	});

	test('a file adopted from disk replaces the document without writing', () => {
		const { draft, session } = open('one\n');
		const inputs = draft.inputs;
		// Adoption sets the buffer directly; it is not an edit.
		draft.buffer = `${HEAD}changed on disk\n`;
		expect(session.sync()?.doc.textContent).toBe('changed on disk');
		expect(draft.inputs).toBe(inputs);
		expect(session.inSync).toBe(true);
	});

	test('the cursor stays where it still fits after a replacement', () => {
		const { run, draft, session } = open('abcdef\n');
		run((state, dispatch) => {
			dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, 3)));
			return true;
		});
		draft.buffer = `${HEAD}abcdef and more\n`;
		expect(session.sync()?.selection.anchor).toBe(3);
		draft.buffer = `${HEAD}a\n`;
		expect(session.sync()?.selection.anchor).toBeLessThanOrEqual(2);
	});
});

describe('source the editor cannot hold', () => {
	test('opens no session', () => {
		expect(createRichSession(draftOf(`${HEAD}<div>x</div>\n`))).toBeUndefined();
		expect(
			createRichSession(draftOf('---\ntitle: *missing\n---\nbody\n')),
		).toBeUndefined();
	});

	test('typed into Source is not pulled into the document', () => {
		const { draft, session } = open('one\n');
		const state = session.state;
		draft.buffer = `${HEAD}![image](x.png)\n`;
		expect(session.sync()).toBeUndefined();
		expect(session.state).toBe(state);
		expect(session.inSync).toBe(false);
	});
});
