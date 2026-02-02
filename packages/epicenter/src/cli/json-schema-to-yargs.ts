import type { JsonSchema } from 'arktype';
import type { Options } from 'yargs';

function isObjectSchema(
	schema: JsonSchema,
): schema is JsonSchema.Object & { properties: Record<string, JsonSchema> } {
	return (
		'type' in schema &&
		schema.type === 'object' &&
		'properties' in schema &&
		schema.properties !== undefined
	);
}

function isEnumSchema(schema: JsonSchema): schema is JsonSchema.Enum {
	return 'enum' in schema && schema.enum !== undefined;
}

function isUnionSchema(schema: JsonSchema): schema is JsonSchema.Union {
	return 'anyOf' in schema && schema.anyOf !== undefined;
}

function isConstSchema(schema: JsonSchema): schema is JsonSchema.Const {
	return 'const' in schema && schema.const !== undefined;
}

function hasType(schema: JsonSchema): schema is JsonSchema.Constrainable & {
	type: JsonSchema.TypeName | JsonSchema.TypeName[];
} {
	return 'type' in schema && schema.type !== undefined;
}

type YargsType = 'string' | 'number' | 'boolean' | 'array' | 'count';

function jsonSchemaTypeToYargsType(
	type: JsonSchema.TypeName | undefined,
): YargsType | undefined {
	switch (type) {
		case 'string':
			return 'string';
		case 'number':
		case 'integer':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'array':
			return 'array';
		default:
			return undefined;
	}
}

function extractChoicesFromUnion(
	variants: readonly JsonSchema[],
): string[] | undefined {
	const choices: string[] = [];

	for (const variant of variants) {
		if (hasType(variant) && variant.type === 'null') continue;

		if (isConstSchema(variant) && typeof variant.const === 'string') {
			choices.push(variant.const);
		} else if (isEnumSchema(variant)) {
			for (const val of variant.enum) {
				if (typeof val === 'string') choices.push(val);
			}
		} else {
			return undefined;
		}
	}

	return choices.length > 0 ? choices : undefined;
}

function fieldSchemaToYargsOption(
	fieldSchema: JsonSchema,
	isRequired: boolean,
): Options {
	const description =
		'description' in fieldSchema
			? (fieldSchema.description as string | undefined)
			: undefined;

	const defaultValue =
		'default' in fieldSchema ? fieldSchema.default : undefined;

	const baseOption: Options = {
		description,
		demandOption: isRequired,
		default: defaultValue,
	};

	if (isEnumSchema(fieldSchema)) {
		const choices = fieldSchema.enum.filter(
			(v): v is string | number =>
				typeof v === 'string' || typeof v === 'number',
		);
		if (choices.length > 0) {
			return {
				...baseOption,
				type: typeof choices[0] === 'number' ? 'number' : 'string',
				choices,
			};
		}
	}

	if (isUnionSchema(fieldSchema)) {
		const choices = extractChoicesFromUnion(fieldSchema.anyOf);
		if (choices) {
			return {
				...baseOption,
				type: 'string',
				choices,
			};
		}
		return baseOption;
	}

	if (isConstSchema(fieldSchema)) {
		const constVal = fieldSchema.const;
		if (typeof constVal === 'string' || typeof constVal === 'number') {
			return {
				...baseOption,
				type: typeof constVal === 'number' ? 'number' : 'string',
				choices: [constVal],
			};
		}
	}

	if (hasType(fieldSchema)) {
		const type = Array.isArray(fieldSchema.type)
			? fieldSchema.type.find((t) => t !== 'null')
			: fieldSchema.type;

		const yargsType = jsonSchemaTypeToYargsType(type);
		if (yargsType) {
			return {
				...baseOption,
				type: yargsType,
			};
		}
	}

	return baseOption;
}

/**
 * Convert JSON Schema to yargs options record.
 *
 * Takes a JSON Schema (typically generated from a StandardSchema action input)
 * and returns a record of yargs option configurations. Uses a permissive approach:
 * if a schema type can't be cleanly mapped to yargs, the option is still created
 * without a type constraint, letting action validation handle strict checking.
 *
 * @example
 * ```typescript
 * const schema = type({ title: 'string', count: 'number?' });
 * const jsonSchema = standardSchemaToJsonSchema(schema);
 * const options = jsonSchemaToYargsOptions(jsonSchema);
 * // { title: { type: 'string', demandOption: true }, count: { type: 'number', demandOption: false } }
 * ```
 */
export function jsonSchemaToYargsOptions(
	schema: JsonSchema,
): Record<string, Options> {
	if (!isObjectSchema(schema)) {
		return {};
	}

	const required = new Set(schema.required ?? []);
	const options: Record<string, Options> = {};

	for (const [key, fieldSchema] of Object.entries(schema.properties)) {
		options[key] = fieldSchemaToYargsOption(fieldSchema, required.has(key));
	}

	return options;
}
