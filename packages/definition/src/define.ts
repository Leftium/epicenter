/** Table declarations keep field schemas separate from the body conversion. */
import type {
	DeclaredMark,
	FieldMap,
	TableBody,
	TableDeclaration,
} from './declaration.js';

type RejectDefault<T> = T extends { default: unknown } ? never : T;

/** Field validation shared with KV; identity remains reserved. */
export type ValidateFields<T extends FieldMap> = {
	[K in keyof T]: K extends string
		? Lowercase<K> extends 'id'
			? `'${K}' is reserved for row identity`
			: RejectDefault<T[K]>
		: RejectDefault<T[K]>;
};

/**
 * The one authoring door for a table, typed for a storage's body conversion.
 * A storage binds `TBody` to what it keeps; the implementation is shared.
 */
export type DefineTable<TBody extends TableBody> = <
	const TTable extends TableDeclaration<TBody>,
>(
	table: TTable & {
		fields: ValidateFields<TTable['fields']>;
	} & Record<Exclude<keyof TTable, keyof TableDeclaration>, never>,
) => DeclaredMark & TTable;

/** Declare value fields and, optionally, how the row's body becomes file text. */
export const defineTable: DefineTable<TableBody> = (table) => table as never;
