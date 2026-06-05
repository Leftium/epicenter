/**
 * The runtime `matter.json` parser/validator.
 *
 * `matter.json` at rest is `{ "fields": Record<fieldName, FieldSchema> }`, where each
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
 * content" is a value constraint (e.g. `minLength`), not a model flag, so `deriveKind`
 * is total and a Field has no `nullable`.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import { deriveKind, isFieldSchema, type Kind } from './palette';
import { compile, type JsonSchema } from './schema';

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
 * One validated, compiled field: the frontmatter key it models, its stored schema
 * (the source of truth; `kind` and `check` are projections of it, and the select
 * cells read its options via `optionsOf`), the UI / storage kind, and the precompiled
 * validator. Computed once per model load, then flows unchanged to conformance, the
 * grid, and (later) the SQLite projector.
 *
 * `name` is identity (the map key, not in the schema); `schema` is the source; `kind`
 * (= `deriveKind(schema)`) and `check` (= `compile(schema)`) are derived ONCE at the
 * parse boundary so downstream readers never re-gate or recompile.
 */
export type Field = {
	/** The frontmatter key this field models. */
	name: string;
	/** The raw JSON Schema as stored in `matter.json`: the source of `kind` and `check`. */
	schema: JsonSchema;
	/** The kind the UI renders and SQLite stores, derived from `schema`. */
	kind: Kind;
	/** The precompiled value validator (`Schema.Compile`), built once. */
	check: (value: unknown) => boolean;
};

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
		// The closed palette is the acceptance rule (`isFieldSchema` checks the
		// meta-schema union). A shape outside it (a typo, an object, a nullable
		// `anyOf` wrapper) is not a typed field: record it so the UI can nudge, let
		// its value surface as an unmodeled extra, and keep classifying the rest.
		if (!isFieldSchema(schema)) {
			unmodeled.push(name);
			continue;
		}
		// `isFieldSchema` proved the shape is a palette member, so this cast is honest
		// and `deriveKind` is total (no json fallback). `compile` runs once per field.
		const fieldSchema = schema as JsonSchema;
		fields.push({
			name,
			schema: fieldSchema,
			kind: deriveKind(fieldSchema),
			check: compile(fieldSchema),
		});
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
