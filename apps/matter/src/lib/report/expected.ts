/**
 * "What did this field expect" as a serializable projection, NOT core data.
 *
 * `core/integrity` classifies an out-of-domain value as `invalid` and carries the raw value
 * plus the {@link Field}; it never says what the field WANTED, because that is a rendering
 * concern. {@link describeExpected} is that render projection: it reads a loaded `Field` and
 * returns a small, serializable {@link ExpectedValue} (a kind, plus the allowed values for the
 * enum kinds). It runs at the edge, when a violation is formatted or serialized to `--json`, so
 * `core` never imports display plumbing. {@link formatExpected} (in `./format`) turns the same
 * value into human text; the two are the JSON edge and the text edge over one shape.
 */

import type { Field, Kind } from '@epicenter/field';

/**
 * The serializable description of a field's accepted value. Every kind reduces to its `kind`
 * name except `select` / `multiSelect`, whose meaning IS their allowed value set, so those two
 * carry the enum members. This is the shape that rides in the `--json` output and feeds
 * {@link formatExpected}; it holds no validator, schema, or function, so it round-trips cleanly.
 */
export type ExpectedValue =
	| { kind: Exclude<Kind, 'select' | 'multiSelect'> }
	| { kind: 'select'; values: unknown[] }
	| { kind: 'multiSelect'; values: unknown[] };

/**
 * Project a loaded {@link Field} into its {@link ExpectedValue}. The `select` / `multiSelect`
 * cases lift the enum members off the typed schema (no cast: `field.kind` narrows `schema` to
 * the matching meta); every other kind is fully described by its name alone. Computed at the
 * report edge from the field a violation carries, never stored in the integrity model.
 */
export function describeExpected(field: Field): ExpectedValue {
	switch (field.kind) {
		case 'select':
			return { kind: 'select', values: [...field.schema.enum] };
		case 'multiSelect':
			return { kind: 'multiSelect', values: [...field.schema.items.enum] };
		case 'string':
		case 'url':
		case 'date':
		case 'instant':
		case 'datetime':
		case 'integer':
		case 'number':
		case 'boolean':
		case 'tags':
		case 'json':
		case 'reference':
			return { kind: field.kind };
		default:
			return field satisfies never;
	}
}
