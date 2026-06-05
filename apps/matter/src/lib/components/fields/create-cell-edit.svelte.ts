/**
 * The shared editing lifecycle for text-input Field components.
 *
 * Five kinds (string, integer, number, url, datetime) and the universal JSON
 * repair editor all edit through a single text input: click to open, type into a
 * local draft, commit on blur/Enter, revert on Escape. That lifecycle, the no-op
 * guard, and the keystroke-buffer "detach while open" invariant are IDENTICAL
 * across them; only the display and the parse differ. This rune helper owns the
 * lifecycle; each Field supplies `display(value) -> text` and `parse(text)`.
 *
 * `parse` returns a DISCRIMINATED result, not a bare value, so a parser never has
 * to overload `undefined` to mean "clear": `clear` calls {@link ClearField}
 * (delete the key), `value` commits through {@link SaveField}, and `error` holds
 * the draft open with a message (the JSON repair editor's bad-syntax case).
 *
 * The returned object is GETTER-BACKED reactive state (plus a `draft` setter for
 * `bind:value`): dot-access it, never destructure, or you snapshot the value and
 * lose reactivity.
 */

import type { ClearField, SaveField } from './types';

export type CellEditParse =
	| { type: 'value'; value: unknown }
	| { type: 'clear' }
	| { type: 'error'; message: string };

export type CreateCellEditOptions = {
	/**
	 * The cell's current committed value, as a getter (not a snapshot): props can
	 * change between `start` and `commit`, and `undefined` means empty. The island
	 * edits a scalar, so it takes the value directly, never the cell's state or field.
	 */
	current: () => unknown;
	save: SaveField;
	clear: ClearField;
	/** Serialize the committed value into the input's initial text. */
	display: (value: unknown) => string;
	/** Interpret the draft text on commit. */
	parse: (draft: string) => CellEditParse;
};

export function createCellEdit(options: CreateCellEditOptions) {
	const { current, save, clear, display, parse } = options;
	let editing = $state(false);
	let draft = $state('');
	let parseError = $state<string | undefined>(undefined);

	function start() {
		draft = display(current());
		parseError = undefined;
		editing = true;
	}

	function cancel() {
		editing = false;
		parseError = undefined;
	}

	function commit() {
		const result = parse(draft);
		if (result.type === 'error') {
			// Hold the edit open with the message; never write unparseable text.
			parseError = result.message;
			return;
		}
		editing = false;
		const value = current();
		// No-op guard: clearing an already-empty cell, or re-committing the same
		// scalar, must not write (and trigger a pointless watcher echo). The two
		// operations are split, so each guards itself.
		if (result.type === 'clear') {
			if (value != null) clear();
		} else if (result.value !== value) {
			save(result.value);
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') commit();
		else if (event.key === 'Escape') cancel();
	}

	return {
		get editing() {
			return editing;
		},
		get draft() {
			return draft;
		},
		set draft(value: string) {
			draft = value;
			// Typing clears a stale parse error so the field can recover.
			parseError = undefined;
		},
		get parseError() {
			return parseError;
		},
		start,
		commit,
		cancel,
		onKeydown,
	};
}
