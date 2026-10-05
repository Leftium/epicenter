/**
 * Svelte reads over a native row editor.
 *
 *     const editor = $derived(fromRowEditor(rowEditor));
 *     editor.row;  // tracked; the native snapshot's row
 *     editor.save; // tracked; the native snapshot's save state
 *
 * `row` and `save` announce a dependency, then return the native `get()`
 * parts. Nothing is copied or cached: every read is the owner's current
 * snapshot, inside or outside an effect. `set`, `setText`, `retry`,
 * `waitForSaves`, and `reload` are the owner's own methods.
 *
 * One `createSubscriber` serves both getters. A read inside an effect, or
 * inside a derived an effect reads, subscribes to the owner's in-memory
 * snapshot; the subscription ends a microtask after the last reading effect
 * is destroyed. Subscribing reads no file and watches nothing. Reads outside
 * any effect or derived subscribe to nothing. Read the native `get()`
 * imperatively for nonreactive work. Unmounting a view ends only its
 * subscription: admitted writes, failures, and retained input belong to the
 * owner, which the application keeps. Adapting the same owner again returns
 * the same wrapper.
 *
 * The adapter guards nothing. Function bindings are caller code: their
 * getters narrow `row`, and their setters return unless the row still
 * supports the view they belong to, because a view that is leaving can still
 * receive input. The package README shows the pattern.
 */
import { createSubscriber } from 'svelte/reactivity';
import type { RowEditor, RowEditorState } from '../editor.js';

/** A row editor whose `row` and `save` reads participate in Svelte tracking. */
export type ReactiveRowEditor<TFields> = Pick<
	RowEditor<TFields>,
	'set' | 'setText' | 'retry' | 'waitForSaves' | 'reload'
> & {
	readonly row: RowEditorState<TFields>['row'];
	readonly save: RowEditorState<TFields>['save'];
};

const wrappers = new WeakMap<object, ReactiveRowEditor<unknown>>();

/** Track a native row editor's snapshot without holding a second copy of it. */
export function fromRowEditor<TFields>(
	editor: RowEditor<TFields>,
): ReactiveRowEditor<TFields> {
	const existing = wrappers.get(editor);
	if (existing) return existing as ReactiveRowEditor<TFields>;
	const { get, subscribe, set, setText, retry, waitForSaves, reload } = editor;
	const track = createSubscriber((update) => subscribe(update));
	const reactive: ReactiveRowEditor<TFields> = Object.freeze({
		get row() {
			track();
			return get().row;
		},
		get save() {
			track();
			return get().save;
		},
		set,
		setText,
		retry,
		waitForSaves,
		reload,
	});
	wrappers.set(editor, reactive as ReactiveRowEditor<unknown>);
	return reactive;
}
