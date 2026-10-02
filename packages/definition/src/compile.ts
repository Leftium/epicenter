/**
 * Compile developer declarations into read lenses.
 *
 * A field is a native TypeBox schema, so preparing one is `Compile`. The
 * compiler adds what a single schema cannot say: usable names, no declared
 * defaults, and a per-field conformance read.
 */

import { Compile } from 'typebox/compile';
import { Memory } from 'typebox/system';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result, trySync } from 'wellcrafted/result';
import { DATA_ADDRESS_CEILINGS, isDataId, isTableName } from './addresses.js';
import {
	type DataDefinition,
	type DataField,
	KV_ROOT,
	RESERVED_TABLE_NAMES,
	type TableBody,
	type TableDeclaration,
} from './declaration.js';
import {
	FIELD_KEYWORD,
	type FieldSchema,
	fieldMetadataOf,
} from './field/index.js';
import { isHelperBuilt } from './field/metadata.js';
import type { JsonObject, JsonValue } from './json.js';

export type ConformanceIssue = { field: string; message: string };

export const DataDefinitionParseError = defineErrors({
	Malformed: ({ reason }: { reason: string }) => ({
		message: `This data definition is not well formed: ${reason}`,
		reason,
	}),
	UnrecognizedField: ({
		table,
		field,
		reason,
	}: {
		table: string;
		field: string;
		reason: string;
	}) => ({
		message: `Field '${table}.${field}' is not a usable field: ${reason}`,
		table,
		field,
		reason,
	}),
	DeclarationDefault: ({ table, field }: { table: string; field: string }) => ({
		message: `Field '${table}.${field}' declares a default; initialization and recovery belong to the application`,
		table,
		field,
	}),
});
export type DataDefinitionParseError = InferErrors<
	typeof DataDefinitionParseError
>;

export type Conformance = {
	conforming: JsonObject;
	issues: ConformanceIssue[];
};

export type ParsedTable<TBody extends TableBody = TableBody> = {
	name: string;
	/**
	 * The value fields, compiled. The body node is NOT here: it holds no
	 * JSON value, so it has no schema to check a payload against and nothing a
	 * conformance read could report.
	 */
	fields: ReadonlyMap<string, DataField>;
	/**
	 * How this table's body node becomes text, carried unread (ADR-0296).
	 *
	 * Absent when the table declares no conversion. What a storage does with
	 * one, or without one, is that storage's rule.
	 */
	body?: TBody;
	conformance(payload: JsonObject): Conformance;
};

export type ParsedDataDefinition<TBody extends TableBody = TableBody> = {
	id: string;
	title?: string;
	kv: ParsedTable<TBody>;
	tables: ReadonlyMap<string, ParsedTable<TBody>>;
};

const parsed = new WeakMap<
	object,
	Result<ParsedDataDefinition, DataDefinitionParseError>
>();

/**
 * Parse and compile one definition, held beside the definition object (ADR-0266).
 *
 * Keyed on object identity, not a content hash. The memo is what makes eager
 * validation free: `defineStore` compiles at the authoring call so a malformed
 * definition fails there rather than at first open (ADR-0266), and without this
 * every opener would redo that work. It is not here for the milliseconds; it is
 * here so "validate early" does not mean "validate twice".
 *
 * Identity keying means a definition MUTATED IN PLACE reads back its old
 * compile. That is the intent: each field is compiled from a frozen snapshot
 * taken here, so what a storage checks and what an editor shows stay the pair
 * that was declared, whatever happens to the declared schema afterwards.
 */
export function compileData<TBody extends TableBody = TableBody>(
	value: DataDefinition<TBody>,
): Result<ParsedDataDefinition<TBody>, DataDefinitionParseError> {
	// The compiler carries each declared conversion through unread, so the
	// parsed bodies are exactly the declared ones.
	type Compiled = Result<ParsedDataDefinition<TBody>, DataDefinitionParseError>;
	const memoised = parsed.get(value);
	if (memoised !== undefined) return memoised as Compiled;
	const result = compileDefinition(value);
	parsed.set(value, result);
	return result as Compiled;
}

function compileDefinition(
	value: unknown,
): Result<ParsedDataDefinition, DataDefinitionParseError> {
	if (!isPlainObject(value))
		return DataDefinitionParseError.Malformed({
			reason: 'it is not a plain object',
		});
	const { id, title, kv, tables } = value as Partial<DataDefinition>;
	if (typeof id !== 'string' || !isDataId(id, DATA_ADDRESS_CEILINGS)) {
		return DataDefinitionParseError.Malformed({
			reason: 'it declares an invalid id',
		});
	}
	if (
		title !== undefined &&
		(typeof title !== 'string' || title.trim() === '')
	) {
		return DataDefinitionParseError.Malformed({
			reason: 'its title must say something or be absent',
		});
	}
	if (!isPlainObject(kv))
		return DataDefinitionParseError.Malformed({
			reason: 'it declares no kv section',
		});
	if (!isPlainObject(tables))
		return DataDefinitionParseError.Malformed({
			reason: 'it declares no tables',
		});

	const compiledKvResult = compileTable(KV_ROOT, kv);
	if (compiledKvResult.error !== null) return compiledKvResult;
	const compiledKv = compiledKvResult.data;
	const compiledTables = new Map<string, ParsedTable>();
	const foldedNames = new Map<string, string>();
	for (const [tableName, declaration] of Object.entries(tables)) {
		if (
			!isTableName(tableName, DATA_ADDRESS_CEILINGS) ||
			RESERVED_TABLE_NAMES.includes(tableName)
		) {
			return DataDefinitionParseError.Malformed({
				reason: `table name '${tableName}' is not usable`,
			});
		}
		const folded = tableName.toLowerCase();
		if (foldedNames.has(folded)) {
			return DataDefinitionParseError.Malformed({
				reason: `table names collide case-insensitively: '${tableName}'`,
			});
		}
		foldedNames.set(folded, tableName);
		if (!isPlainObject(declaration)) {
			return DataDefinitionParseError.Malformed({
				reason: `table '${tableName}' must declare fields and an optional body codec`,
			});
		}
		const table = declaration as TableDeclaration;
		if (Object.keys(table).some((key) => key !== 'fields' && key !== 'body')) {
			return DataDefinitionParseError.Malformed({
				reason: `table '${tableName}' declares an unknown option`,
			});
		}
		if (table.body !== undefined && !isBodyCodec(table.body)) {
			return DataDefinitionParseError.Malformed({
				reason: `table '${tableName}' declares an invalid body codec`,
			});
		}
		const result = compileTable(tableName, table.fields);
		if (result.error !== null) return result;
		compiledTables.set(tableName, {
			...result.data,
			body: table.body,
		});
	}
	return Ok(
		Object.freeze({
			id,
			...(title === undefined ? {} : { title }),
			kv: compiledKv,
			tables: compiledTables,
		}),
	);
}

function compileTable(
	tableName: string,
	declaration: unknown,
): Result<ParsedTable, DataDefinitionParseError> {
	if (!isPlainObject(declaration))
		return DataDefinitionParseError.Malformed({
			reason: `table '${tableName}' does not declare a flat field map`,
		});
	const compiled = new Map<string, DataField>();
	for (const [fieldName, declared] of Object.entries(declaration)) {
		const invalid = fieldNameProblem(tableName, fieldName);
		if (invalid !== undefined) return invalid;
		if (fieldMetadataOf(declared) === null) {
			return DataDefinitionParseError.UnrecognizedField({
				table: tableName,
				field: fieldName,
				reason: 'a field is declared with field.*',
			});
		}
		if (declaresDefault(declared)) {
			return DataDefinitionParseError.DeclarationDefault({
				table: tableName,
				field: fieldName,
			});
		}
		// After the default check, so a spread field that carries a default is
		// still told about the default.
		if (!isHelperBuilt(declared as object)) {
			return DataDefinitionParseError.UnrecognizedField({
				table: tableName,
				field: fieldName,
				reason:
					'it lost what its field.* helper built; a spread or a rebuilt schema drops hidden constraints',
			});
		}
		const prepared = trySync({
			try: () => {
				const schema = snapshot(declared as FieldSchema);
				return { schema, validator: Compile(schema) };
			},
			catch: (cause) =>
				DataDefinitionParseError.UnrecognizedField({
					table: tableName,
					field: fieldName,
					reason: String(cause),
				}),
		});
		if (prepared.error) return prepared;
		const { schema, validator } = prepared.data;
		const metadata = schema[FIELD_KEYWORD];
		compiled.set(
			fieldName,
			Object.freeze({
				name: fieldName,
				kind: metadata.kind,
				nullable: metadata.nullable,
				reference: metadata.kind === 'reference' ? metadata.target : null,
				metadata,
				schema,
				check: (value: unknown) => validator.Check(value),
				errors: (value: unknown) =>
					validator.Errors(value).map((error) => error.message),
			}),
		);
	}
	return Ok(
		Object.freeze({
			name: tableName,
			fields: compiled,
			conformance(payload: JsonObject): Conformance {
				const conforming: JsonObject = {};
				const issues: ConformanceIssue[] = [];
				for (const [fieldName, field] of compiled) {
					if (!Object.hasOwn(payload, fieldName)) {
						issues.push({
							field: fieldName,
							message: `${fieldName} is missing`,
						});
					} else if (!field.check(payload[fieldName])) {
						const [detail] = field.errors(payload[fieldName]);
						issues.push({
							field: fieldName,
							message: `${fieldName} is not a conforming ${field.kind} value${
								detail === undefined ? '' : `: ${detail}`
							}`,
						});
					} else {
						conforming[fieldName] = payload[fieldName] as JsonValue;
					}
				}
				return { conforming, issues };
			},
		}),
	);
}

/**
 * A frozen native copy of a declared schema: what a field is compiled from.
 *
 * `Memory.Clone` is TypeBox's own clone. It copies own string-keyed data
 * properties, hidden ones included, so every native constraint comes along. It
 * copies functions and `~guard` objects by reference, and those stay as they
 * are here: freezing one would freeze the author's state. Symbol keys,
 * accessors, and what a refinement callback closes over are outside what this
 * snapshot holds still.
 */
function snapshot<S extends object>(declared: S): S {
	const schema = Memory.Clone(declared) as S;
	const pending: unknown[] = [schema];
	while (pending.length > 0) {
		const value = pending.pop();
		if (typeof value !== 'object' || value === null) continue;
		if (Object.isFrozen(value) || '~guard' in value) continue;
		if (!Array.isArray(value) && !isPlainObject(value)) continue;
		Object.freeze(value);
		for (const key of Object.getOwnPropertyNames(value))
			pending.push(Object.getOwnPropertyDescriptor(value, key)?.value);
	}
	return schema;
}

/** Keywords whose value maps names to schemas, so a key there is not a keyword. */
const NAMED_SCHEMAS: readonly string[] = [
	'properties',
	'patternProperties',
	'$defs',
	'definitions',
	'dependentSchemas',
];

/** Keywords whose value is one schema, or a list of them. */
const SUBSCHEMAS: readonly string[] = [
	'items',
	'prefixItems',
	'anyOf',
	'allOf',
	'oneOf',
	'not',
	'if',
	'then',
	'else',
	'additionalProperties',
	'contains',
	'propertyNames',
	'unevaluatedProperties',
	'unevaluatedItems',
];

/**
 * Whether a schema declares a `default` anywhere a schema can.
 *
 * It follows only the keywords that hold schemas. So a payload property NAMED
 * `default` (`Type.Object({ default: Type.String() })`) is a name, and a
 * `default` key inside a `const`, an `enum` member, an annotation, or a
 * `dependentRequired` map is data; none of those is a declared default.
 */
function declaresDefault(schema: unknown, seen = new Set<object>()): boolean {
	if (typeof schema !== 'object' || schema === null || seen.has(schema))
		return false;
	seen.add(schema);
	if (Array.isArray(schema))
		return schema.some((child) => declaresDefault(child, seen));
	if (Object.hasOwn(schema, 'default')) return true;
	const keywords = schema as Record<string, unknown>;
	return (
		SUBSCHEMAS.some((keyword) => declaresDefault(keywords[keyword], seen)) ||
		NAMED_SCHEMAS.some((keyword) => {
			const named = keywords[keyword];
			return (
				typeof named === 'object' &&
				named !== null &&
				!Array.isArray(named) &&
				Object.values(named).some((child) => declaresDefault(child, seen))
			);
		})
	);
}

function fieldNameProblem(
	tableName: string,
	fieldName: string,
): Result<never, DataDefinitionParseError> | undefined {
	if (
		fieldName.toLowerCase() === 'id' ||
		!/^[A-Za-z!][A-Za-z0-9_!]*$/.test(fieldName)
	) {
		return DataDefinitionParseError.Malformed({
			reason: `field name '${tableName}.${fieldName}' is not usable`,
		});
	}
	return undefined;
}

/** Check both conversion verbs at the runtime definition boundary. */
function isBodyCodec(value: unknown): value is TableBody {
	const codec = value as Partial<TableBody> | undefined;
	return (
		typeof codec?.encode === 'function' && typeof codec.decode === 'function'
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
