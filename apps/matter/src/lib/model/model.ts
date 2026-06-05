/**
 * The runtime `matter.json` parser/validator.
 *
 * `matter.json` at rest is `{ "fields": Record<fieldName, JsonSchema> }`, where
 * each field value is a plain JSON Schema (the `column.*` subset). This module
 * is the gate that turns that raw JSON into a trustworthy {@link MatterModel}:
 *
 *   - the top-level shape must be `{ fields: { ... } }`
 *   - every field value must be a schema in the SUPPORTED SUBSET (the shapes
 *     `deriveKind` recognizes), optionally wrapped in the nullable `anyOf` shape
 *
 * Junk (bad JSON, wrong top-level shape, a field outside the subset) is REJECTED
 * with a clear diagnostic so the caller can fall back to the raw view and surface
 * a non-blocking banner. The model never gates a write; this gate only decides
 * whether a stored model is usable at all.
 *
 * We validate STRUCTURALLY (not with a TypeBox schema-of-schemas) because the
 * acceptance rule is exactly "does `deriveKind` recognize this," which is a
 * shape walk, not a JSON-Schema match. One definition of "supported," shared
 * with the renderer.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import { type DerivedKind, deriveKind, type JsonSchema } from './schema';

/** Why a stored `matter.json` could not be read into a usable model. */
export const MatterModelError = defineErrors({
	NotAnObject: () => ({ message: 'matter.json must be a JSON object' }),
	MissingFields: () => ({
		message: 'matter.json must have a "fields" object',
	}),
	FieldNotObject: ({ field }: { field: string }) => ({
		message: `Field "${field}" must be a JSON Schema object`,
		field,
	}),
	UnsupportedShape: ({ field }: { field: string }) => ({
		message: `Field "${field}" uses an unsupported schema shape`,
		field,
	}),
	InvalidJson: ({ cause }: { cause: unknown }) => ({
		message: `matter.json is not valid JSON: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MatterModelError = InferErrors<typeof MatterModelError>;

/** A validated model: each field's stored schema plus its derived kind. */
export type ModelField = {
	/** The frontmatter key this field models. */
	name: string;
	/** The raw JSON Schema as stored in `matter.json`. */
	schema: JsonSchema;
	/** The kind the UI renders, derived from `schema`. */
	derived: DerivedKind;
};

/** A folder's validated model, in declared (insertion) order. */
export type MatterModel = {
	fields: ModelField[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' && value !== null && !Array.isArray(value)
	);
}

/**
 * Validate a parsed `matter.json` object into a {@link MatterModel}. Takes the
 * already-JSON-parsed value ({@link parseModel} reads the file text and handles
 * the syntax-error case).
 */
export function validateModel(
	raw: unknown,
): Result<MatterModel, MatterModelError> {
	if (!isPlainObject(raw)) return MatterModelError.NotAnObject();

	const fieldsRaw = raw.fields;
	if (!isPlainObject(fieldsRaw)) return MatterModelError.MissingFields();

	const fields: ModelField[] = [];
	for (const [name, schema] of Object.entries(fieldsRaw)) {
		if (!isPlainObject(schema)) {
			return MatterModelError.FieldNotObject({ field: name });
		}
		// `json` is the catch-all kind: it is the tell that NO recognizer matched,
		// i.e. the shape is outside the supported subset (one definition of
		// "supported", shared with the renderer). Reject it with a diagnostic so the
		// caller can fall back to the raw view. Nullable wrappers are unwrapped
		// inside `deriveKind`, so the `anyOf`-with-null shape is accepted too.
		const derived = deriveKind(schema);
		if (derived.kind === 'json') {
			return MatterModelError.UnsupportedShape({ field: name });
		}
		fields.push({ name, schema, derived });
	}

	return Ok({ fields });
}

/**
 * Parse the raw text of a `matter.json` file. Catches JSON syntax errors as an
 * `Err` (carrying the parser error as `cause`) rather than throwing, so a junk
 * file degrades to the raw view with a diagnostic.
 */
export function parseModel(text: string): Result<MatterModel, MatterModelError> {
	const { data: raw, error } = trySync({
		try: () => JSON.parse(text) as unknown,
		catch: (cause) => MatterModelError.InvalidJson({ cause }),
	});
	if (error) return Err(error);
	return validateModel(raw);
}
