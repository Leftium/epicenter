/**
 * The runtime `matter.json` parser/validator.
 *
 * `matter.json` at rest is `{ "fields": Record<fieldName, JsonSchema> }`, where each
 * field value is a plain JSON Schema in the closed palette. This module turns that
 * raw JSON into a {@link MatterModel}: a flat list of {@link Field}s, each carrying
 * its kind (the widget / storage classifier) and its precompiled validator, computed
 * ONCE here when the model loads. "Field" is the source noun (the user defines a
 * folder's fields); SQLite is the one consumer that turns fields into table columns.
 *
 * The acceptance rule is the meta-schema in `palette.ts`: a field whose stored shape
 * is a legal palette member becomes a typed Field; a field OUTSIDE the palette (a
 * typo, an object, a nullable wrapper) is recorded in `unmodeled` and shown raw,
 * rather than erroring the whole model. Only WHOLE-FILE junk (bad JSON, no `fields`
 * object) rejects the model to the raw view.
 *
 * There is no optional / nullable axis: every modeled field is required. "Must have
 * content" is a value constraint (e.g. `minLength`), not a model flag, so a Field
 * carries a bare `kind` and has no `nullable`.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import { compile, type Kind, recognize, type SchemaOf } from './palette';

/** Why a stored `matter.json` could not be read into a usable model at all. */
export const MatterModelError = defineErrors({
	NotAnObject: () => ({ message: 'matter.json must be a JSON object' }),
	MissingFields: () => ({
		message: 'matter.json must have a "fields" object',
	}),
	InvalidJson: ({ cause }: { cause: unknown }) => ({
		message: `matter.json is not valid JSON: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MatterModelError = InferErrors<typeof MatterModelError>;

/**
 * One validated, compiled field of kind `K`: the frontmatter key it models, its
 * precisely-typed stored schema, the kind, and the precompiled validator. `FieldOf<K>`
 * is the per-kind variant, so `FieldOf<'select'>['schema']['enum']` is typed; {@link
 * Field} is the discriminated union over every kind, so a `switch (field.kind)` narrows
 * `schema` to the matching shape with no cast.
 *
 * `name` is identity (the map key, not in the schema); `schema`, `kind`, and `check`
 * are derived ONCE at the parse boundary (`recognize` + `compile`) so downstream readers
 * never re-gate or recompile.
 */
export type FieldOf<K extends Kind> = {
	/** The frontmatter key this field models. */
	name: string;
	/** This field's kind: the discriminant. */
	kind: K;
	/** The precisely-typed JSON Schema as stored in `matter.json`. */
	schema: SchemaOf<K>;
	/** The precompiled value validator (`Schema.Compile`), built once. */
	check: (value: unknown) => boolean;
};

/** A validated, compiled field: the discriminated union over every kind. */
export type Field = { [K in Kind]: FieldOf<K> }[Kind];

/** A folder's validated model: the typed fields plus any fields outside the palette. */
export type MatterModel = {
	/** The typed fields, in declared (insertion) order. */
	fields: Field[];
	/** Field names whose stored shape is outside the palette; shown raw, never typed. */
	unmodeled: string[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' && value !== null && !Array.isArray(value)
	);
}

/**
 * Validate a parsed `matter.json` object into a {@link MatterModel}. Takes the
 * already-JSON-parsed value ({@link parseModel} reads the file text and handles the
 * syntax-error case). Per-field degrade: a field outside the palette is recorded in
 * `unmodeled`, never an error; only whole-file junk returns an `Err`.
 */
export function validateModel(
	raw: unknown,
): Result<MatterModel, MatterModelError> {
	if (!isPlainObject(raw)) return MatterModelError.NotAnObject();

	const fieldsRaw = raw.fields;
	if (!isPlainObject(fieldsRaw)) return MatterModelError.MissingFields();

	const fields: Field[] = [];
	const unmodeled: string[] = [];
	for (const [name, schema] of Object.entries(fieldsRaw)) {
		// The closed palette is the acceptance rule: `recognize` returns the kind paired
		// with its typed schema, or null for a shape outside it (a typo, an object, a
		// nullable `anyOf` wrapper). An unrecognized field is not a typed field: record it
		// so the UI can nudge, let its value surface as an unmodeled extra, and keep going.
		const recognized = recognize(schema);
		if (recognized === null) {
			unmodeled.push(name);
			continue;
		}
		// `recognized` carries the kind and its precisely-typed schema in one pass, so the
		// Field is built with no cast. `compile` runs once per field; its validator rides
		// on the Field for conformance to reuse.
		fields.push({ name, ...recognized, check: compile(recognized.schema) });
	}

	return Ok({ fields, unmodeled });
}

/**
 * Parse the raw text of a `matter.json` file. Catches JSON syntax errors as an `Err`
 * (carrying the parser error as `cause`) rather than throwing, so a junk file degrades
 * to the raw view with a diagnostic.
 */
export function parseModel(text: string): Result<MatterModel, MatterModelError> {
	const { data: raw, error } = trySync({
		try: () => JSON.parse(text) as unknown,
		catch: (cause) => MatterModelError.InvalidJson({ cause }),
	});
	if (error) return Err(error);
	return validateModel(raw);
}
