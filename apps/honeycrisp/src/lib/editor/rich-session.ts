/**
 * The rich-text view's editing session: one ProseMirror state, its undo
 * history, and its tie to the note's body.
 *
 * The note's row editor holds the one document; this session is a view of its
 * Markdown body, and two rules keep them the same:
 *
 * - Every transaction that changes the document is checked before it is
 *   shown. If its Markdown would not parse back to an equivalent document,
 *   or the draft cannot or will not take it, the transaction is refused and
 *   the screen does not change. If it passes, the draft receives the Markdown
 *   in the same step. There is never text on screen that the draft does not
 *   hold.
 * - When the body changes from anywhere else (the Markdown view, a file the
 *   editor followed, a version the person chose), `sync` replaces the
 *   document and starts a new undo history, because the old history
 *   describes text that is gone.
 *
 * The session has no DOM. A view displays `state` and sends transactions to
 * `apply`; tests drive it the same way.
 */
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
import { bodyText, richAvailability } from '../note-source.js';
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

/** The body the rich-text view reads and writes: one note's, shared with its other views. */
export type BodyDraft = {
	readonly body: string;
	/** Take the whole new body. False means it was not taken. */
	input(body: string): boolean;
	refuse(reason: string): void;
};

export type RichSession = NonNullable<ReturnType<typeof createRichSession>>;

/**
 * Open a session on a draft whose body is editable as rich text. Returns
 * undefined when it is not; the caller shows why from `richAvailability`.
 */
export function createRichSession(
	draft: BodyDraft,
	{
		viewPlugins = [],
	}: {
		/** Plugins that need a DOM, such as decorations and click handlers. */
		viewPlugins?: readonly Plugin[];
	} = {},
) {
	const opened = richAvailability(draft.body);
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
			const current = draft.body;
			const body = bodyText(check.markdown, current);
			// An edit Markdown has no spelling for (a new empty paragraph) leaves
			// the body as it is, so it does not make the note newer.
			if (body !== current) {
				// Input that is not being taken is not shown either.
				if (!draft.input(body)) return undefined;
				syncedBody = draft.body;
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
			if (draft.body === syncedBody) return undefined;
			const available = richAvailability(draft.body);
			if (!available.editable) return undefined;
			syncedBody = available.body;
			state = stateFor(available.inspection.doc, state);
			return state;
		},
		/** Whether the draft's body is the one this document stands for. */
		get inSync() {
			return draft.body === syncedBody;
		},
	};
}
