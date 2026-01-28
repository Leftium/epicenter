/**
 * Converts cell SchemaFieldDefinition to TypeBox TSchema for runtime validation.
 *
 * Cell schemas differ from core Field types - they're simpler advisory definitions
 * stored as external JSON. This converter handles that simpler structure.
 *
 * TypeBox schemas can be compiled to JIT validators using `Compile()` from `typebox/compile`.
 *
 * @packageDocumentation
 */

import { type TObject, type TSchema, Type } from 'typebox';
import type {
	FieldType,
	SchemaFieldDefinition,
	SchemaTableDefinition,
} from '../types';

/**
 * Converts a single SchemaFieldDefinition to a TypeBox TSchema.
 *
 * All fields are nullable in cell workspace (advisory schema).
 *
 * Field type mappings:
 * - `text`, `richtext` -> `Type.String()`
 * - `integer` -> `Type.Integer()`
 * - `real` -> `Type.Number()`
 * - `boolean` -> `Type.Boolean()`
 * - `date`, `datetime` -> `Type.String()`
 * - `select` -> `Type.Union([Type.Literal(...), ...])` if options, else `Type.String()`
 * - `tags` -> `Type.Array(Type.Union([...]))` if options, else `Type.Array(Type.String())`
 * - `json` -> `Type.Unknown()`
 *
 * @param field - The field definition to convert
 * @returns A TypeBox TSchema wrapped with nullable (union with null)
 *
 * @example
 * ```typescript
 * const schema = schemaFieldToTypebox({ name: 'Title', type: 'text', order: 1 });
 * // Returns Type.Union([Type.String(), Type.Null()])
 * ```
 */
export function schemaFieldToTypebox(field: SchemaFieldDefinition): TSchema {
	const baseType = fieldTypeToTypebox(field.type, field.options);
	// All cell fields are nullable (advisory schema)
	return Type.Union([baseType, Type.Null()]);
}

/**
 * Converts a field type to its base TypeBox schema (without nullable wrapper).
 */
function fieldTypeToTypebox(
	type: FieldType,
	options?: string[],
): TSchema {
	switch (type) {
		case 'text':
		case 'richtext':
			return Type.String();

		case 'integer':
			return Type.Integer();

		case 'real':
			return Type.Number();

		case 'boolean':
			return Type.Boolean();

		case 'date':
		case 'datetime':
			// Accept any string for dates (no strict validation in cell workspace)
			return Type.String();

		case 'select': {
			if (options && options.length > 0) {
				const literals = options.map((value) => Type.Literal(value));
				return Type.Union(literals);
			}
			return Type.String();
		}

		case 'tags': {
			if (options && options.length > 0) {
				const literals = options.map((value) => Type.Literal(value));
				return Type.Array(Type.Union(literals));
			}
			return Type.Array(Type.String());
		}

		case 'json':
			return Type.Unknown();
	}
}

/**
 * Converts a SchemaTableDefinition to a TypeBox TObject schema.
 *
 * The resulting schema allows additional properties (fields not in schema pass validation).
 * This supports the advisory nature of cell schemas.
 *
 * @param table - The table definition with field definitions
 * @returns A TypeBox TObject schema with additionalProperties enabled
 *
 * @example
 * ```typescript
 * import { Compile } from 'typebox/compile';
 *
 * const tableSchema = schemaTableToTypebox({
 *   name: 'Posts',
 *   fields: {
 *     title: { name: 'Title', type: 'text', order: 1 },
 *     views: { name: 'Views', type: 'integer', order: 2 },
 *   }
 * });
 *
 * const validator = Compile(tableSchema);
 * validator.Check({ title: 'Hello', views: 100 }); // true
 * validator.Check({ title: 'Hello', views: null }); // true (nullable)
 * validator.Check({ title: 'Hello', views: 100, extra: 'field' }); // true (additional props)
 * ```
 */
export function schemaTableToTypebox(table: SchemaTableDefinition): TObject {
	const properties: Record<string, TSchema> = {};

	for (const [fieldName, fieldDef] of Object.entries(table.fields)) {
		// Wrap each field as Optional - missing fields are valid (advisory schema)
		properties[fieldName] = Type.Optional(schemaFieldToTypebox(fieldDef));
	}

	return Type.Object(properties, { additionalProperties: true });
}
