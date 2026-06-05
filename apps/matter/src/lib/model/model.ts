/**
 * The runtime `matter.json` parser/validator.
 *
 * `matter.json` at rest is `{ "fields": Record<fieldName, JsonSchema> }`, where each
 * field value is a plain JSON Schema in the closed palette. This module turns that
 * raw JSON into a {@link MatterModel}: a flat list of {@link Column}s, each carrying
 * its kind (the widget / storage classifier) and its precompiled validator, computed
 * ONCE here when the model loads.
 *
 * The acceptance rule is the meta-schema in `palette.ts`: a field whose stored shape
 * is a legal palette member becomes a typed Column; a field OUTSIDE the palette (a
 * typo, an object, a nullable wrapper) is recorded in `unmodeled` and shown raw,
 * rather than erroring the whole model. Only WHOLE-FILE junk (bad JSON, no `fields`
 * object) rejects the model to the raw view.
 *
 * There is no optional / nullable axis: every modeled field is required. "Must have
 * content" is a value constraint (e.g. `minLength`), not a model flag, so a Column
 * carries a bare `kind` and has no `nullable`.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import { compile, type JsonSchema, type Kind, recognize } from './palette';

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
 * One validated, compiled column: the frontmatter key it models, its stored schema
 * (cells read `schema.enum` / `schema.items` off it), the UI / storage kind, and the
 * precompiled validator. Computed once per model load, then flows unchanged to
 * conformance, the grid, and (later) the SQLite projector.
 */
export type Column = {
	/** The frontmatter key this column models. */
	name: string;
	/** The raw JSON Schema as stored in `matter.json`. */
	schema: JsonSchema;
	/** The kind the UI renders and SQLite stores, derived from `schema`. */
	kind: Kind;
	/** The precompiled value validator (`Schema.Compile`), built once. */
	check: (value: unknown) => boolean;
};

/** A folder's validated model: the typed columns plus any fields outside the palette. */
export type MatterModel = {
	/** The typed columns, in declared (insertion) order. */
	columns: Column[];
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

	const columns: Column[] = [];
	const unmodeled: string[] = [];
	for (const [name, schema] of Object.entries(fieldsRaw)) {
		// The closed palette is the acceptance rule: `recognize` returns the kind whose
		// meta matches, or null for a shape outside it (a typo, an object, a nullable
		// `anyOf` wrapper). An unrecognized field is not a typed column: record it so the
		// UI can nudge, let its value surface as an unmodeled extra, and keep going.
		const kind = recognize(schema);
		if (kind === null) {
			unmodeled.push(name);
			continue;
		}
		// `recognize` proved the shape is a palette member and handed back its kind in
		// one pass, so this cast is honest. `compile` runs once per column.
		const fieldSchema = schema as JsonSchema;
		columns.push({
			name,
			schema: fieldSchema,
			kind,
			check: compile(fieldSchema),
		});
	}

	return Ok({ columns, unmodeled });
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
