/**
 * TypeBox compilation for Matter's stored field schemas.
 *
 * A field at rest is a plain JSON Schema in the closed palette. RECOGNITION
 * (schema -> kind, and "is this a legal palette member") lives in `palette.ts`; this
 * module owns the two TypeBox touch points on Matter's VALUE path: registering the
 * value-semantic formats, and the single `Schema.Compile` call that turns a stored
 * schema into a per-cell validator.
 *
 * `JsonSchema` is the at-rest shape the cells read (`schema.enum` / `schema.items`)
 * and `compile`'s input. We do not import TypeBox's `TSchema` because the truth is
 * plain JSON, not a TypeBox value, and `Schema.Compile` validates a plain JSON Schema
 * directly.
 */

import { Format } from 'typebox/format';
import * as Schema from 'typebox/schema';

/**
 * A JSON Schema as it sits in `matter.json`: a plain object literal. The named keys
 * are exactly the ones recognizers and cells READ, typed so they flow without a
 * per-reader cast. The closed shape (no index signature) catches typos; the ONE
 * assertion that a parsed disk object IS this shape lives at the parse boundary in
 * `model.ts`, after `isFieldSchema` has proven it is a palette member.
 */
export type JsonSchema = {
	type?: string | string[];
	format?: string;
	enum?: unknown[];
	anyOf?: JsonSchema[];
	items?: JsonSchema;
};

/**
 * Register the value-semantic formats so `format: 'uri'` / `format: 'date-time'`
 * actually enforce. TypeBox treats an UNREGISTERED format as "always passes", so
 * without this every string would satisfy `url` / `datetime`. Idempotent; `compile`
 * calls it before the first `Schema.Compile`, so there is no import-time side effect.
 */
export function registerFormats(): void {
	Format.Set('uri', Format.IsUri);
	Format.Set('date-time', Format.IsDateTime);
}

/**
 * Compile a stored JSON Schema into a value check. The ONE place `Schema.Compile` is
 * called: it registers the value-semantic formats first (idempotent), then closes
 * over the validator rather than tearing `Check` off (it reads `this`).
 */
export function compile(schema: JsonSchema): (value: unknown) => boolean {
	registerFormats();
	const validator = Schema.Compile(schema);
	return (value) => validator.Check(value);
}
