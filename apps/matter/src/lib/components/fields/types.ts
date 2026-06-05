/**
 * The contract every per-kind Field component implements.
 *
 * A Field renders AND edits one cell whose value is in its kind's domain (`OK`)
 * or empty (`EMPTY` / `NEEDS_VALUE`). It NEVER handles `INVALID`: an out-of-domain
 * value cannot fit a typed widget, so the {@link ModeledCell} wrapper routes those
 * to the universal JSON repair editor before a Field is ever chosen. Kind dispatch
 * is gated behind validity, so a Field only ever sees a value it can represent.
 *
 * A Field owns its own open/editing local state (the keystroke-buffer island) and
 * writes through {@link SaveField}; it never mutates the projection. The write
 * comes back through the watcher and reclassifies the row, so a value that leaves
 * the kind's domain reappears as INVALID (handled by the wrapper, not the Field).
 */

import type { CellResult } from '$lib/model/conformance';
import type { ModelField } from '$lib/model/model';

/**
 * Commit a new value for this cell's field. The {@link ModeledCell} wrapper binds
 * the row name and field key; a Field supplies only the value. Clearing the field
 * is a SEPARATE call ({@link ClearField}), not `save(undefined)`: committing a
 * value and removing the key are two unlike operations, so they are two call
 * shapes, not one channel with a sentinel.
 */
export type SaveField = (value: unknown) => void;

/**
 * Clear this cell's field: delete the key (never write `null`, the nullish
 * contract). The honest counterpart to {@link SaveField}.
 */
export type ClearField = () => void;

/** Props every per-kind Field component receives. */
export type FieldProps = {
	/** The classified cell: its value and state (`OK` / `EMPTY` / `NEEDS_VALUE`). */
	cell: CellResult;
	/** The model field: its stored schema (select options, list items) and derived kind. */
	field: ModelField;
	/** Commit a new value for the field. */
	save: SaveField;
	/** Delete the field's key (the explicit clear, not `save(undefined)`). */
	clear: ClearField;
};
