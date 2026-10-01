/**
 * The rich-text view's editing session: one ProseMirror state, its undo
 * history, and its tie to the note's draft.
 *
 * The draft is the one logical buffer. This session is a view of its body,
 * and two rules keep them the same:
 *
 * - Every transaction that changes the document is checked before it is
 *   shown. If its Markdown would not parse back to an equivalent document,
 *   or the draft cannot take it, the transaction is refused and the screen
 *   does not change. If it passes, the draft receives the Markdown in the
 *   same step. There is never text on screen that the draft does not hold.
 * - When the draft's body changes from anywhere else (the Source view, a
 *   file adopted from disk, a discarded conflict), `sync` replaces the
 *   document and starts a new undo history, because the old history
 *   describes text that is gone.
 *
 * The session has no DOM. A view displays `state` and sends transactions to
 * `apply`; tests drive it the same way.
 */
import { readSource } from '@epicenter/app/files';
import {
	baseKeymap,
	chainCommands,
	exitCode,
	lift,
	toggleMark,
	wrapIn,
} from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import {
	ellipsis,
	inputRules,
	smartQuotes,
	textblockTypeInputRule,
	wrappingInputRule,
} from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import type { MarkType, Node, NodeType } from 'prosemirror-model';
import {
	liftListItem,
	sinkListItem,
	splitListItem,
} from 'prosemirror-schema-list';
import {
	type Command,
	EditorState,
	type Plugin,
	type Selection,
	TextSelection,
	type Transaction,
} from 'prosemirror-state';
import { instantNow, type NoteFields } from '../data.js';
import { applyRichBody, bodyText, richAvailability } from '../note-source.js';
import { checkNoteDoc } from './markdown.js';
import { noteSchema } from './schema.js';

export const marks = noteSchema.marks as unknown as Record<
	'strong' | 'em' | 'strike' | 'code' | 'link',
	MarkType
>;
export const nodes = noteSchema.nodes as unknown as Record<
	| 'paragraph'
	| 'heading'
	| 'blockquote'
	| 'code_block'
	| 'bullet_list'
	| 'ordered_list'
	| 'list_item'
	| 'taskList'
	| 'taskItem'
	| 'horizontal_rule'
	| 'hard_break',
	NodeType
>;

export function nodeActive(
	state: EditorState,
	type: NodeType,
	attrs?: Record<string, unknown>,
): boolean {
	const { $from: start } = state.selection;
	for (let depth = start.depth; depth >= 0; depth -= 1) {
		const node = start.node(depth);
		if (node.type !== type) continue;
		if (!attrs) return true;
		if (
			Object.entries(attrs).every(([key, value]) => node.attrs[key] === value)
		)
			return true;
	}
	return false;
}

export const toggleQuote: Command = (state, dispatch) =>
	nodeActive(state, nodes.blockquote)
		? lift(state, dispatch)
		: wrapIn(nodes.blockquote)(state, dispatch);

const hardBreak: Command = chainCommands(exitCode, (state, dispatch) => {
	dispatch?.(
		state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView(),
	);
	return true;
});

/** Editing behavior that needs no DOM: history, keys, and typing shortcuts. */
function editingPlugins(): Plugin[] {
	return [
		history(),
		keymap({
			'Mod-z': undo,
			'Mod-y': redo,
			'Mod-Shift-z': redo,
			'Mod-b': toggleMark(marks.strong),
			'Mod-i': toggleMark(marks.em),
			'Mod-Shift-s': toggleMark(marks.strike),
			'Mod-e': toggleMark(marks.code),
			'Mod-Shift-b': toggleQuote,
			'Shift-Enter': hardBreak,
			Enter: chainCommands(
				splitListItem(nodes.taskItem),
				splitListItem(nodes.list_item),
				baseKeymap.Enter as Command,
			),
			Tab: (state, dispatch) =>
				sinkListItem(nodes.taskItem)(state, dispatch) ||
				sinkListItem(nodes.list_item)(state, dispatch),
			'Shift-Tab': (state, dispatch) =>
				liftListItem(nodes.taskItem)(state, dispatch) ||
				liftListItem(nodes.list_item)(state, dispatch),
		}),
		keymap(baseKeymap),
		inputRules({
			rules: [
				...smartQuotes,
				ellipsis,
				textblockTypeInputRule(/^(#{1,3})\s$/, nodes.heading, (match) => ({
					level: (match[1] as string).length,
				})),
				wrappingInputRule(/^\s*\[([ xX]?)\]\s$/, nodes.taskList),
				wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
				wrappingInputRule(
					/^(\d+)\.\s$/,
					nodes.ordered_list,
					(match) => ({ order: Number(match[1]) }),
					(match, node) =>
						node.childCount + node.attrs.order === Number(match[1]),
				),
				wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
				textblockTypeInputRule(/^```$/, nodes.code_block),
			],
		}),
	];
}

/** The part of a draft the session reads and writes. */
export type SessionDraft = {
	readonly buffer: string;
	input(text: string): void;
	refuse(reason: string): void;
};

export type RichSession = NonNullable<ReturnType<typeof createRichSession>>;

/**
 * Open a session on a draft whose source is editable as rich text. Returns
 * undefined when it is not; the caller shows why from `richAvailability`.
 */
export function createRichSession(
	draft: SessionDraft,
	{
		now = instantNow,
		viewPlugins = [],
	}: {
		now?: () => NoteFields['updatedAt'];
		/** Plugins that need a DOM, such as decorations and click handlers. */
		viewPlugins?: readonly Plugin[];
	} = {},
) {
	const opened = richAvailability(draft.buffer);
	if (!opened.editable) return undefined;
	const plugins = [...editingPlugins(), ...viewPlugins];

	function stateFor(doc: Node, previous?: EditorState): EditorState {
		let selection: Selection | undefined;
		if (previous)
			try {
				const size = doc.content.size;
				selection = TextSelection.between(
					doc.resolve(Math.min(previous.selection.anchor, size)),
					doc.resolve(Math.min(previous.selection.head, size)),
				);
			} catch {
				selection = undefined;
			}
		return EditorState.create({ doc, plugins, selection });
	}

	let state = stateFor(opened.inspection.doc);
	/**
	 * The body text the document stands for: what it was parsed from, or what
	 * it last wrote. A draft body that is anything else was changed elsewhere.
	 */
	let syncedBody = opened.body;

	return {
		get state() {
			return state;
		},
		/**
		 * Apply a transaction. Returns the state to display, or undefined when
		 * the transaction was refused and nothing changed.
		 */
		apply(transaction: Transaction): EditorState | undefined {
			const next = state.apply(transaction);
			if (!transaction.docChanged) {
				// A selection change writes nothing: opening a note never changes its file.
				state = next;
				return next;
			}
			const check = checkNoteDoc(next.doc);
			if (!check.ok) {
				draft.refuse(check.reason);
				return undefined;
			}
			const current = readSource(draft.buffer).body;
			// An edit Markdown has no spelling for (a new empty paragraph) leaves
			// the body as it is, so it does not make the note newer.
			if (
				current === undefined ||
				bodyText(check.markdown, current) !== current
			) {
				const patched = applyRichBody(draft.buffer, check.markdown, now());
				if (patched.error !== null) {
					draft.refuse(patched.error);
					return undefined;
				}
				syncedBody = readSource(patched.data).body ?? syncedBody;
				draft.input(patched.data);
			}
			state = next;
			return next;
		},
		/**
		 * Compare with the draft. When its body was changed elsewhere and is
		 * still editable as rich text, replace the document and reset the undo
		 * history; the cursor stays where it still fits. Returns the new state,
		 * or undefined when nothing was replaced.
		 */
		sync(): EditorState | undefined {
			const body = readSource(draft.buffer).body;
			if (body === undefined || body === syncedBody) return undefined;
			const available = richAvailability(draft.buffer);
			if (!available.editable) return undefined;
			syncedBody = available.body;
			state = stateFor(available.inspection.doc, state);
			return state;
		},
		/** Whether the draft's body is the one this document stands for. */
		get inSync() {
			return readSource(draft.buffer).body === syncedBody;
		},
	};
}
