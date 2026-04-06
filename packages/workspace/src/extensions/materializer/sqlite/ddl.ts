/**
 * Generate SQLite DDL from workspace JSON Schema descriptors.
 *
 * The SQLite mirror only needs the latest materialized row shape. When a table
 * schema has multiple versions, this module picks the highest `_v` variant and
 * generates a `CREATE TABLE IF NOT EXISTS` statement that preserves the exact
 * workspace field names.
 *
 * Complex values like arrays and objects are stored as JSON-serialized `TEXT`
 * columns because the mirror is a read cache, not the source-of-truth schema.
 *
 * @module
 */

type JsonSchema = Record<string, unknown>;

/**
 * Resolve the concrete schema variant used for SQLite DDL generation.
 *
 * Multi-version workspace tables expose a `oneOf` where each entry represents a
 * versioned row shape. The workspace read path migrates rows to the latest
 * version before materialization, so the SQLite mirror should generate columns
 * from the schema whose `_v.const` is highest.
 *
 * If the schema is not versioned, this returns the original object unchanged.
 *
 * @param schema - A JSON Schema object from `describeWorkspace()`
 * @returns The highest-version object schema when `oneOf` is present, otherwise the original schema
 *
 * @example
 * ```typescript
 * const resolved = resolveSchema({
 *   oneOf: [
 *     { type: 'object', properties: { _v: { const: 1 }, id: { type: 'string' } } },
 *     { type: 'object', properties: { _v: { const: 2 }, id: { type: 'string' }, title: { type: 'string' } } },
 *   ],
 * });
 *
 * // Picks the `_v: 2` schema
 * console.log((resolved.properties as Record<string, unknown>).title);
 * ```
 */
export function resolveSchema(schema: JsonSchema): JsonSchema {
	const candidates = Array.isArray(schema.oneOf)
		? schema.oneOf.filter(isRecord)
		: undefined;

	if (candidates === undefined || candidates.length === 0) {
		return schema;
	}

	let resolved: JsonSchema | undefined;
	let highestVersion = Number.NEGATIVE_INFINITY;

	for (const candidate of candidates) {
		const version = getSchemaVersion(candidate);
		if (resolved === undefined || version > highestVersion) {
			resolved = candidate;
			highestVersion = version;
		}
	}

	if (resolved === undefined) {
		return schema;
	}

	return resolved;
}

/**
 * Generate a `CREATE TABLE IF NOT EXISTS` statement for a workspace table.
 *
 * This mirrors the JSON Schema shape exposed by `describeWorkspace()` into a
 * SQLite table definition. Required scalar fields become `NOT NULL`, `id`
 * becomes the primary key, version discriminants use `INTEGER NOT NULL`, and
 * complex values are stored as JSON text.
 *
 * @param tableName - The SQLite table name to create
 * @param jsonSchema - The JSON Schema from `describeWorkspace().tables[name].schema`
 * @returns A `CREATE TABLE IF NOT EXISTS` SQL statement
 *
 * @example
 * ```typescript
 * const sql = generateDdl('posts', {
 *   type: 'object',
 *   properties: {
 *     id: { type: 'string' },
 *     _v: { const: 2 },
 *     title: { type: 'string' },
 *     published: { type: 'boolean' },
 *   },
 *   required: ['id', '_v', 'title'],
 * });
 *
 * // CREATE TABLE IF NOT EXISTS "posts" ("id" TEXT PRIMARY KEY, "_v" INTEGER NOT NULL, "title" TEXT NOT NULL, "published" INTEGER)
 * ```
 */
export function generateDdl(
	tableName: string,
	jsonSchema: Record<string, unknown>,
): string {
	const resolved = resolveSchema(jsonSchema);
	const properties = getProperties(resolved);
	const required = getRequiredSet(resolved);
	const columns = Object.entries(properties).map(([name, propSchema]) =>
		columnDef(name, toSchema(propSchema), required.has(name)),
	);

	return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (${columns.join(', ')})`;
}

function columnDef(
	name: string,
	propSchema: JsonSchema,
	isRequired: boolean,
): string {
	const quotedName = quoteIdentifier(name);

	if (name === 'id') {
		return `${quotedName} TEXT PRIMARY KEY`;
	}

	if (name === '_v' && typeof propSchema.const === 'number') {
		return `${quotedName} INTEGER NOT NULL`;
	}

	if (Array.isArray(propSchema.enum)) {
		return appendNullability(`${quotedName} TEXT`, isRequired);
	}

	const jsonType =
		typeof propSchema.type === 'string' ? propSchema.type : undefined;

	switch (jsonType) {
		case 'string':
			return appendNullability(`${quotedName} TEXT`, isRequired);
		case 'number':
			return appendNullability(`${quotedName} REAL`, isRequired);
		case 'integer':
			return appendNullability(`${quotedName} INTEGER`, isRequired);
		case 'boolean':
			return appendNullability(`${quotedName} INTEGER`, isRequired);
		case 'object':
		case 'array':
			return `${quotedName} TEXT`;
		default:
			return appendNullability(`${quotedName} TEXT`, isRequired);
	}
}

function appendNullability(column: string, isRequired: boolean) {
	if (!isRequired) {
		return column;
	}

	return `${column} NOT NULL`;
}

function getSchemaVersion(schema: JsonSchema) {
	const properties = schema.properties;
	if (!isRecord(properties)) {
		return Number.NEGATIVE_INFINITY;
	}

	const versionSchema = properties._v;
	if (!isRecord(versionSchema) || typeof versionSchema.const !== 'number') {
		return Number.NEGATIVE_INFINITY;
	}

	return versionSchema.const;
}

function getProperties(schema: JsonSchema) {
	if (!isRecord(schema.properties)) {
		throw new Error(
			'SQLite DDL generation requires an object schema with properties.',
		);
	}

	return schema.properties;
}

function getRequiredSet(schema: JsonSchema) {
	if (!Array.isArray(schema.required)) {
		return new Set<string>();
	}

	return new Set(
		schema.required.filter(
			(value): value is string => typeof value === 'string',
		),
	);
}

function quoteIdentifier(identifier: string) {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function toSchema(value: unknown): JsonSchema {
	if (!isRecord(value)) {
		throw new Error(
			'SQLite DDL generation requires each property schema to be an object.',
		);
	}

	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
