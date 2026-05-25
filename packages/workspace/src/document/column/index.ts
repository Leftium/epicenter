/**
 * Public surface of the `column.*` sugar layer and the `FlatJsonTSchema`
 * constraint.
 *
 * Users may freely mix `column.X()` and raw `Type.X()`; `FlatJsonTSchema`
 * enforces safety regardless of which call site produced the schema.
 */

export type { ColumnError, FlatJsonTSchema } from './constraint';
export {
	boolean,
	column,
	dateTime,
	enum_,
	ianaTimeZone,
	type Infer,
	integer,
	json,
	literal,
	nullable,
	number,
	string,
} from './sugar';
export type { NumberOpts, SchemaMetadata, StringOpts } from './types';
export {
	deriveCheck,
	deriveStorage,
	isNullable,
	type SqliteStorage,
} from './derive';
