/**
 * Schema-on-read: a type's `columns` are a LENS over a page's stored values,
 * never a gate or a migration.
 *
 * Changing a type's schema does not rewrite any page. Instead, at read time we
 * line a page's stored `types[typeId]` values up against the type's CURRENT
 * columns and bucket each property:
 *
 *   match    in data AND in schema   render typed (with a validity flag)
 *   excess   in data, not in schema  kept verbatim; offer to remove
 *   missing  in schema, not in data  show empty / a "fill me" prompt
 *
 * Pure: it reads, it never writes. The durable Yjs/markdown data is untouched;
 * only the rendered view reflects the current schema.
 */

import { Value } from 'typebox/value';
import type { JsonValue } from 'wellcrafted/json';
import type { ColumnSpec } from './schema';

/** A property present in both the data and the current schema. */
export type LensMatch = {
	id: string;
	name: string;
	value: JsonValue;
	/**
	 * Whether `value` satisfies the column's current schema. `false` is a soft
	 * signal (the schema widened/changed under stored data), not a drop:
	 * schema-on-read never deletes durable values.
	 */
	valid: boolean;
};

/** A property the schema declares but the page has no value for. */
export type LensMissing = { id: string; name: string };

/** A stored value with no matching column in the current schema. */
export type LensExcess = { id: string; value: JsonValue };

export type TypeLens = {
	typeId: string;
	match: LensMatch[];
	missing: LensMissing[];
	excess: LensExcess[];
};

/**
 * Project one page's values for one type through that type's current columns.
 *
 * `data` is the page's `types[typeId]` cell (or `undefined` when the page does
 * not carry the type, in which case every column reads as missing).
 */
export function viewThroughType({
	typeId,
	columns,
	data,
}: {
	typeId: string;
	columns: ColumnSpec[];
	data: Record<string, JsonValue> | undefined;
}): TypeLens {
	const values = data ?? {};
	const schemaIds = new Set(columns.map((c) => c.id));

	const match: LensMatch[] = [];
	const missing: LensMissing[] = [];
	for (const spec of columns) {
		if (!Object.hasOwn(values, spec.id)) {
			missing.push({ id: spec.id, name: spec.name });
			continue;
		}
		const value = values[spec.id]!;
		match.push({
			id: spec.id,
			name: spec.name,
			value,
			valid: Value.Check(spec.schema, value),
		});
	}

	const excess: LensExcess[] = [];
	for (const [id, value] of Object.entries(values)) {
		if (!schemaIds.has(id)) excess.push({ id, value });
	}

	return { typeId, match, missing, excess };
}
