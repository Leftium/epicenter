/**
 * What an application declares, and what that declaration reads as.
 *
 * All vocabulary and no behaviour. A definition separates each table's value fields
 * from its optional body conversion; the lens at the
 * bottom turns that declaration into the types an application writes.
 *
 * Every type here is a LOOKUP. None asks whether its argument is a
 * declaration, because the parameter says so, and none can answer `never` for
 * "I could not tell". A definition that arrived as JSON never comes through
 * here: it reaches `compileData` from a trusted TypeScript module and is
 * checked in `compile.ts`.
 */

import type { Static, TSchema } from 'typebox';
import type { FieldEditor } from './field/index.js';

export { field } from './field/index.js';

export const KV_ROOT = 'kv';
export const RESERVED_TABLE_NAMES: readonly string[] = [KV_ROOT];

/**
 * The fields of one bucket, by name.
 *
 * A field is any native TypeBox schema. The `field.*` helpers build common
 * ones and annotate them with an editor; a bare `Type.Object(...)`,
 * `Type.Enum(...)`, `Type.Any()`, or `Type.Refine(...)` is a field too, and
 * gets the JSON editor.
 */
export type FieldMap = {
	// TypeBox's `TSchema` is an empty interface, which a string or a number
	// satisfies. A schema is an object.
	readonly [field: string]: TSchema & object;
};

/**
 * The widest body conversion a table may declare: two verbs between a live
 * body and file text.
 *
 * This package compiles declarations for more than one storage. What a live
 * body is belongs to the storage that keeps one, so the node and the decoded
 * content are opaque here. A storage narrows them through the `TBody`
 * parameter below; one that keeps no live body refuses a declared conversion.
 */
export type TableBody = {
	readonly encode: (node: never) => string;
	readonly decode: (text: string) => unknown;
};

/** Value-field schemas and the optional conversion for the row's separately edited body. */
export type TableDeclaration<TBody extends TableBody = TableBody> = {
	readonly fields: FieldMap;
	readonly body?: TBody;
};

/**
 * The mark `defineTable` leaves, and the only way to get one.
 *
 * A table declaration is a plain object, so any literal of the right shape used
 * to satisfy `DataDefinition`. That made two authoring paths for one thing:
 * `defineTable`, which checks its parameter, and a bare literal handed to
 * `defineStore`, which needed a second set of conditional types to re-check the
 * same rules and could not report them as well. Every rule was written twice
 * and one of the copies silently stopped applying for a day.
 *
 * Nominal, so there is one door. Nothing constructs this value: the brand is
 * declared and never assigned, and `defineTable`'s return asserts it.
 */
declare const DECLARED: unique symbol;

/**
 * The mark alone, without the shape.
 *
 * `defineTable` returns this intersected with the literal types it inferred,
 * never with `TableDeclaration`, so the row lens sees the exact field keys.
 */
export type DeclaredMark = { readonly [DECLARED]: true };

/** A table declaration that went through `defineTable`. */
export type DeclaredTable<TBody extends TableBody = TableBody> =
	TableDeclaration<TBody> & DeclaredMark;

/** One durable data domain's complete, inert definition. */
export type DataDefinition<TBody extends TableBody = TableBody> = {
	readonly id: string;
	readonly title?: string;
	readonly kv: FieldMap;
	readonly tables: {
		readonly [table: string]: DeclaredTable<TBody>;
	};
};

/** A field diagnostic. Messages and diagnostic counts are not machine contracts. */
export type ConformanceIssue = {
	field: string;
	/** JSON pointer within the field value, when the validator identifies it. */
	path?: string;
	message: string;
};

/**
 * One declared field, prepared: the lens a storage reads a cell through.
 *
 * The field's name is its key in `ParsedTable.fields`; the field does not
 * repeat it.
 *
 * `schema` is the native schema `check` and `issues` were compiled from, a
 * frozen copy of the declared one. A node with a `~guard` is the exception:
 * TypeBox keeps that whole node by reference, so it is the author's object
 * and is not frozen. `editor` is resolved from `schema` and decides nothing
 * about a value: it says which widget edits the field, whether `null` is a
 * value, and a select's options or a reference's target.
 *
 */
export type DataField = {
	readonly editor: FieldEditor;
	readonly schema: TSchema & object;
	/**
	 * Whether a value is JSON and TypeBox's compiled check admits it. This is
	 * the only decision about a value. A throwing validation fails that value.
	 */
	readonly check: (value: unknown) => boolean;
	/**
	 * Why a value fails `check`: that it is not JSON, TypeBox's own errors with
	 * the paths that can be walked in the value, or that schema validation
	 * threw. Empty when `check` passes; a value TypeBox refuses without an
	 * error still gets one issue. A table's `conformance` and `inputIssues`
	 * report these same issues.
	 */
	readonly issues: (value: unknown) => readonly ConformanceIssue[];
};

/** What one bucket's fields read as, once the schemas are resolved. */
type FieldsOut<TFields extends FieldMap> = {
	[K in keyof TFields]: Static<TFields[K]>;
};

/** A value snapshot. A storage with live bodies reaches them through its own handle. */
export type RowOf<T extends TableDeclaration> = { id: string } & FieldsOut<
	T['fields']
>;

/** Values supplied when creating a row. */
export type CreateRowOf<T extends TableDeclaration> = FieldsOut<T['fields']>;

export type KvOf<TDatabase extends DataDefinition> = FieldsOut<TDatabase['kv']>;
