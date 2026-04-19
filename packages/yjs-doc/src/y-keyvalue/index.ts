/**
 * Storage-efficient key-value primitives over Y.Array.
 *
 * - {@link YKeyValue} — positional (rightmost-wins) conflict resolution.
 * - {@link YKeyValueLww} — timestamp-based last-write-wins.
 *
 * Both are unencrypted Yjs primitives. The encrypted wrapper composes
 * over `YKeyValueLww` and lives in `@epicenter/workspace`.
 */
export {
	YKeyValue,
	type YKeyValueChange,
	type YKeyValueChangeHandler,
	type YKeyValueEntry,
} from './y-keyvalue.js';

export {
	YKeyValueLww,
	type YKeyValueLwwChange,
	type YKeyValueLwwChangeHandler,
	type YKeyValueLwwEntry,
} from './y-keyvalue-lww.js';
