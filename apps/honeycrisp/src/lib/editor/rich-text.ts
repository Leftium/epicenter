/**
 * The rich-text view's editing: its commands and plugins, and the two rules
 * that keep its ProseMirror state the note's body.
 *
 * The view's `EditorState` is the one rich-text state: document, cursor,
 * pending formatting, and undo history. The note's row editor holds the one
 * body. Nothing records which body the state last read or wrote; the body is
 * compared by content:
 *
 * - `stateAfter` decides every transaction before it is shown. One that
 *   changes the document is checked against the current body first, then its
 *   Markdown goes to the note's editor in the same step. If the Markdown
 *   would not open as the same document, or the editor refuses it, the screen
 *   does not change. There is never text on screen that the editor does not
 *   hold.
 * - `stateShowing` follows the body. The same content keeps the state, so a
 *   body this view wrote, or a respelling in Source, changes nothing on
 *   screen. Different content (Source, a reloaded file, a chosen version)
 *   starts a new state and a new undo history, because the old history
 *   describes text that is gone.
 *
 * Neither needs a DOM. The view calls both; tests drive them the same way.
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
	type Transaction,
} from 'prosemirror-state';
import type { BodyDraft } from '../note-source.js';
import { equivalentNoteDocs } from './markdown.js';
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

/**
 * Editing behavior that needs no DOM: history, keys, and typing shortcuts.
 * Each call makes new plugins; a state built from them starts its own history.
 */
export function editingPlugins(): Plugin[] {
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

/**
 * The state that shows `doc`, the note's body as a document. That is `state`
 * itself while its document holds the same content, so its cursor, pending
 * formatting, and undo history stay. Otherwise it is a new state over `doc`
 * with the same plugins: a new undo history, with the cursor at the start.
 */
export function stateShowing(state: EditorState, doc: Node): EditorState {
	if (equivalentNoteDocs(doc, state.doc)) return state;
	return EditorState.create({ doc, plugins: state.plugins });
}

/**
 * The state to show after `transaction`, or undefined when the screen stays
 * as it is.
 *
 * A transaction built on a document `state` no longer has is dropped: its
 * steps describe text that was replaced. One that changes the document first
 * meets the body as it is now. A body that changed elsewhere since `state`
 * showed it is shown instead and the transaction is dropped; a body that is
 * no longer rich text takes nothing, and the view leaves for Source. Then the
 * new document goes to the note's editor, and is shown only once it was taken.
 */
export function stateAfter(
	state: EditorState,
	transaction: Transaction,
	draft: Pick<BodyDraft, 'rich' | 'inputDoc'>,
): EditorState | undefined {
	if (transaction.before !== state.doc) return undefined;
	// A selection or pending formatting writes nothing: opening a note never
	// changes its file.
	if (!transaction.docChanged) return state.apply(transaction);
	const current = draft.rich;
	if (!current.editable) return undefined;
	const shown = stateShowing(state, current.inspection.doc);
	if (shown !== state) return shown;
	const next = state.apply(transaction);
	return draft.inputDoc(next.doc) ? next : undefined;
}
