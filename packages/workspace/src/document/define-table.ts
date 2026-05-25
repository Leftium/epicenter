/**
 * `defineTable(...)` — TypeBox-native versioned table definition.
 *
 * Every column schema flows through the `FlatJsonTSchema` mapped-type
 * constraint, which rejects every TypeBox `~kind` that cannot materialize
 * 1:1 to a SQLite column. Users may construct columns via `column.X()` or
 * raw `Type.X()` interchangeably; the constraint enforces safety either way.
 *
 * `_v` stays explicit at every boundary: declared as `_v: column.literal(N)`
 * in each schema and passed as `_v: N as const` at every write site. The
 * library reads `_v` from storage and looks up the matching schema by
 * literal value. Variadic argument order is metadata only; the only
 * objective error caught at definition time is a duplicated `_v` literal.
 *
 * @example
 * ```ts
 * const notes = defineTable({
 *   _v: column.literal(1),
 *   id: column.string<NoteId>(),
 *   title: column.string({ minLength: 1, maxLength: 200 }),
 *   createdAt: column.dateTime(),
 * });
 *
 * const versioned = defineTable(
 *   { _v: column.literal(1), id: column.string<NoteId>(), title: column.string() },
 *   { _v: column.literal(2), id: column.string<NoteId>(), title: column.string(), pinned: column.boolean() },
 * ).migrate((row) => {
 *   switch (row._v) {
 *     case 1: return { ...row, pinned: false, _v: 2 as const };
 *     case 2: return row;
 *   }
 * });
 * ```
 */

import type { TLiteral } from 'typebox';
import {
	type AnyVersionRow,
	createTableDefinition,
	type RowOf,
	type TableDefinition,
	type VersionedColumns,
} from './attach-table';
import type { FlatJsonTSchema } from './column/constraint';

/**
 * Apply `FlatJsonTSchema` per column. Used DIRECTLY as `defineTable`'s
 * parameter type (never intersected with `TCols`), so column-level errors
 * surface as readable English tooltips at the offending field rather than
 * collapsing to `never`.
 */
type ConstrainColumns<TCols extends VersionedColumns> = {
	[K in keyof TCols]: FlatJsonTSchema<TCols[K]>;
};

type ConstrainVersions<TVersions extends readonly VersionedColumns[]> = {
	[I in keyof TVersions]: TVersions[I] extends VersionedColumns
		? ConstrainColumns<TVersions[I]>
		: never;
};

type LastVersion<TVersions extends readonly VersionedColumns[]> =
	TVersions extends readonly [...infer _, infer L]
		? L extends VersionedColumns
			? L
			: TVersions[number]
		: TVersions[number];

/**
 * Intermediate builder returned by the variadic overload until `.migrate(fn)`
 * is supplied. Intentionally NOT assignable to `TableDefinition`, so
 * attaching the unfinished builder to a Y.Doc is a compile error.
 */
type MigrationRequired<TVersions extends readonly VersionedColumns[]> = {
	migrate(
		fn: (row: AnyVersionRow<TVersions>) => RowOf<LastVersion<TVersions>>,
	): TableDefinition<TVersions>;
};

// Single-version overload: no migrate step needed.
export function defineTable<const TCols extends VersionedColumns>(
	v1: ConstrainColumns<TCols>,
): TableDefinition<[TCols]>;

// Multi-version overload: migrate is required before the definition is usable.
export function defineTable<
	const TVersions extends readonly [
		VersionedColumns,
		VersionedColumns,
		...VersionedColumns[],
	],
>(...versions: ConstrainVersions<TVersions>): MigrationRequired<TVersions>;

export function defineTable(
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly; overloads constrain caller-visible shape
	...args: any[]
	// biome-ignore lint/suspicious/noExplicitAny: see above
): any {
	if (args.length === 0) {
		throw new Error('defineTable() requires at least one schema argument');
	}

	const versions = args as readonly VersionedColumns[];
	assertUniqueVersionLiterals(versions);

	if (versions.length === 1) {
		const onlyColumns = versions[0]!;
		return createTableDefinition(
			[onlyColumns] as const,
			(row) => row as RowOf<VersionedColumns>,
		);
	}

	return {
		migrate(fn: (row: unknown) => unknown) {
			return createTableDefinition(
				versions,
				fn as (row: unknown) => RowOf<VersionedColumns>,
			);
		},
	};
}

/**
 * Runtime guard: every version must carry an `_v: column.literal(N)` field,
 * and no two versions may declare the same `N`. Order is the developer's
 * choice; the library matches stored rows by `_v` value, not by argument
 * position.
 */
function assertUniqueVersionLiterals(
	versions: readonly VersionedColumns[],
): void {
	const seen = new Set<number>();
	versions.forEach((cols, idx) => {
		const literalSchema = cols._v as TLiteral<number> | undefined;
		if (!literalSchema || typeof literalSchema.const !== 'number') {
			throw new Error(
				`defineTable() version at position ${idx} is missing an _v: column.literal(N) field`,
			);
		}
		const value = literalSchema.const;
		if (seen.has(value)) {
			throw new Error(
				`defineTable() duplicate _v literal: ${value}. Each version must declare a unique _v.`,
			);
		}
		seen.add(value);
	});
}

export type { RowOf, TableDefinition, VersionedColumns } from './attach-table';
