/**
 * Prepare developer declarations for reading.
 *
 * A field is a native TypeBox schema, and a prepared definition has the shape
 * it was declared in: `kv` and each table's `fields` are records of native
 * schemas. Preparation adds what a declaration cannot say by itself: usable
 * names, an owned frozen snapshot of each schema, and TypeBox's compiled
 * validator for that snapshot, held privately beside it.
 *
 * The reads are {@link accepts}, {@link conformance}, and {@link inputIssues}.
 * Each asks whether a value is JSON before the schema's validator sees it, and
 * none changes the value it is given. A `default` annotation in a schema is
 * inert: nothing fills a missing value, and a missing declared field is still
 * an issue. A native callback in a schema is held to the same rule: it is
 * given a frozen copy.
 */

import type { TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { Memory } from 'typebox/system';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result, trySync } from 'wellcrafted/result';
import { DATA_ADDRESS_CEILINGS, isDataId, isTableName } from './addresses.js';
import {
	type ConformanceIssue,
	type DataDefinition,
	type DataSchema,
	type FieldMap,
	KV_ROOT,
	RESERVED_TABLE_NAMES,
	type TableBody,
	type TableDeclaration,
} from './declaration.js';
import { isJsonSafe, type JsonObject, type JsonValue } from './json.js';

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
});
export type DataDefinitionParseError = InferErrors<
	typeof DataDefinitionParseError
>;

export type Conformance = {
	conforming: JsonObject;
	issues: ConformanceIssue[];
};

/** One memo per shape, so a definition and a schema never answer for each other. */
type Memo = WeakMap<object, Result<DataSchema, DataDefinitionParseError>>;
const preparedDefinitions: Memo = new WeakMap();
const preparedSchemas: Memo = new WeakMap();

/** Internal export boundary: only the owned result, never its raw memo key. */
export function isPreparedSchema(value: DataSchema): boolean {
	return [preparedDefinitions, preparedSchemas].some((memo) => {
		const result = memo.get(value);
		return result?.error === null && result.data === value;
	});
}

/**
 * Check one definition and return the copy every read uses (ADR-0266).
 *
 * The result has the declared shape and the declared type: `id`, an optional
 * `title`, `kv`, and `tables`, each table holding `fields` and its optional
 * `body`. It is owned here. Every field is a frozen snapshot of the declared
 * schema (see `snapshot`). `kv`, `tables`, and each `fields` are frozen
 * records without a prototype, so a name like `constructor` reads as its own
 * entry or as nothing. A body conversion is carried by reference and never
 * read.
 *
 * Names come from the record keys and are stored nowhere else. No field or
 * table name can be an integer, so a record keeps its declaration order.
 *
 * Memoised on object identity, for the declaration handed in and for the
 * definition handed back, so preparing a prepared definition returns it. The
 * memo is what makes eager validation free: `defineStore` prepares at the
 * authoring call so a malformed definition fails there, not at first open,
 * and an opener given that result does no work twice.
 *
 * Identity keying means a declaration MUTATED IN PLACE reads back its old
 * preparation. That is the intent: the prepared definition is a snapshot.
 * Guard-bearing nodes are retained by reference by TypeBox and remain
 * author-owned; see `snapshot` for that exception.
 */
export function prepareData<TDefinition extends DataDefinition>(
	value: TDefinition,
): Result<TDefinition, DataDefinitionParseError> {
	// The snapshot has the declared shape, so it has the declared type.
	return memoised(preparedDefinitions, value, prepareDefinition) as Result<
		TDefinition,
		DataDefinitionParseError
	>;
}

/**
 * Check one schema, a declaration that names no dataset, and return the copy
 * every read uses.
 *
 * Everything {@link prepareData} says holds, except the identity: the result
 * is an optional `title`, `kv`, and `tables`, and a declaration with an own
 * `id` is malformed. A storage that selects its dataset when it opens takes
 * the ID there, so an ID here would name nothing. The memo is its own: a
 * prepared definition is not a prepared schema, and the reverse.
 */
export function prepareSchema<
	TSchema extends DataSchema & { readonly id?: never },
>(value: TSchema): Result<TSchema, DataDefinitionParseError> {
	return memoised(preparedSchemas, value, prepareIdentityFree) as Result<
		TSchema,
		DataDefinitionParseError
	>;
}

function memoised(
	memo: Memo,
	value: unknown,
	prepare: (value: unknown) => Result<DataSchema, DataDefinitionParseError>,
): Result<DataSchema, DataDefinitionParseError> {
	// A declaration that arrived untyped may not be an object, and only an
	// object can be a memo key.
	if (typeof value !== 'object' || value === null) return prepare(value);
	const found = memo.get(value);
	if (found !== undefined) return found;
	const result = prepare(value);
	memo.set(value, result);
	if (result.error === null) memo.set(result.data, result);
	return result;
}

function prepareDefinition(
	value: unknown,
): Result<DataDefinition, DataDefinitionParseError> {
	if (!isPlainObject(value))
		return DataDefinitionParseError.Malformed({
			reason: 'it is not a plain object',
		});
	const { id } = value as Partial<DataDefinition>;
	if (typeof id !== 'string' || !isDataId(id, DATA_ADDRESS_CEILINGS)) {
		return DataDefinitionParseError.Malformed({
			reason: 'it declares an invalid id',
		});
	}
	const schema = prepareShape(value);
	if (schema.error !== null) return schema;
	return Ok(Object.freeze({ id, ...schema.data }));
}

function prepareIdentityFree(
	value: unknown,
): Result<DataSchema, DataDefinitionParseError> {
	if (!isPlainObject(value))
		return DataDefinitionParseError.Malformed({
			reason: 'it is not a plain object',
		});
	if (Object.hasOwn(value, 'id'))
		return DataDefinitionParseError.Malformed({
			reason: 'it declares an id, and a schema names no dataset',
		});
	return prepareShape(value);
}

/** The prepared title, kv, and tables of a plain-object declaration. */
function prepareShape(
	value: Record<string, unknown>,
): Result<DataSchema, DataDefinitionParseError> {
	const { title, kv, tables } = value as Partial<DataSchema>;
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

	const preparedKv = prepareFields(KV_ROOT, kv);
	if (preparedKv.error !== null) return preparedKv;
	const preparedTables: Record<string, TableDeclaration> = Object.create(null);
	const foldedNames = new Set<string>();
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
		foldedNames.add(folded);
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
		const fields = prepareFields(tableName, table.fields);
		if (fields.error !== null) return fields;
		// One declared table reused under two names is prepared once per name.
		preparedTables[tableName] = Object.freeze({
			fields: fields.data,
			...(table.body === undefined ? {} : { body: table.body }),
		});
	}
	return Ok(
		Object.freeze({
			...(title === undefined ? {} : { title }),
			kv: preparedKv.data,
			// `defineTable`'s mark is a type and nothing at run time.
			tables: Object.freeze(preparedTables) as DataSchema['tables'],
		}),
	);
}

function prepareFields(
	tableName: string,
	declaration: unknown,
): Result<FieldMap, DataDefinitionParseError> {
	if (!isPlainObject(declaration))
		return DataDefinitionParseError.Malformed({
			reason: `table '${tableName}' does not declare a flat field map`,
		});
	const fields: Record<string, TSchema & object> = Object.create(null);
	for (const [fieldName, declared] of Object.entries(declaration)) {
		if (
			fieldName.toLowerCase() === 'id' ||
			!/^[A-Za-z!][A-Za-z0-9_!]*$/.test(fieldName)
		) {
			return DataDefinitionParseError.Malformed({
				reason: `field name '${tableName}.${fieldName}' is not usable`,
			});
		}
		if (!isPlainObject(declared)) {
			return DataDefinitionParseError.UnrecognizedField({
				table: tableName,
				field: fieldName,
				reason: 'a field is a TypeBox schema',
			});
		}
		const field = trySync({
			try: () => {
				const { schema, callbacks } = snapshot(declared);
				validations.set(schema, { validator: Compile(schema), callbacks });
				return schema;
			},
			catch: (cause) =>
				DataDefinitionParseError.UnrecognizedField({
					table: tableName,
					field: fieldName,
					reason: String(cause),
				}),
		});
		if (field.error) return field;
		fields[fieldName] = field.data;
	}
	return Ok(Object.freeze(fields));
}

/**
 * A prepared schema's compiled validator, and whether the schema holds a
 * native callback.
 */
type Validation = {
	validator: ReturnType<typeof Compile>;
	callbacks: boolean;
};

/**
 * The validation of each schema this module owns, keyed on the snapshot.
 *
 * A snapshot is a fresh copy for every field of every preparation. So a
 * declared schema reused in two definitions, or under two names, has two
 * entries, and an edit between two preparations reaches only the second. The
 * author's own schema is never a key. A schema whose ROOT has a `~guard` is
 * the exception `snapshot` documents: TypeBox hands that node back itself, so
 * the key is the author's object and it reads through the latest
 * preparation's validator.
 */
const validations = new WeakMap<object, Validation>();

/** Export must remember guards even if an author later removes their marker. */
export function hasSchemaCallbacks(schema: TSchema & object): boolean {
	return validationOf(schema).callbacks;
}

/**
 * The validation of a prepared schema.
 *
 * A schema this module did not prepare has none. That is a programmer error
 * and throws: compiling it here would validate against a schema nothing
 * froze, and answering `false` would report the mistake as a refused value.
 */
function validationOf(schema: TSchema & object): Validation {
	const validation = validations.get(schema);
	if (validation === undefined)
		throw new Error(
			'This schema was not prepared. Read fields from the definition that prepareData, prepareSchema, defineStore, or defineFolder returned.',
		);
	return validation;
}

/**
 * What a validator is given for `value`: a frozen copy when the schema holds a
 * native callback, so the callback cannot write to what the caller holds (see
 * {@link frozenCopy}), and the value itself when the schema is keywords alone.
 */
function readable({ callbacks }: Validation, value: unknown): unknown {
	return callbacks ? frozenCopy(value) : value;
}

/**
 * Whether a value is JSON and the prepared schema's compiled check admits it.
 * This is the only decision about a value.
 *
 * A schema can be structural about what it admits (`Type.Any()` admits a
 * `Date`, `undefined`, and a cycle), and none of those survives being stored.
 * So the JSON question is asked of every field, before its schema and
 * whatever the schema says. Before, because a recursive schema
 * (`Type.Cyclic`) follows a cyclic value until the stack overflows; it must
 * never see one.
 *
 * `isJsonSafe` sets no depth or width limit. A storage that has a budget
 * applies it itself. A native validator can throw on a refinement or deep
 * recursion: that value is then not accepted.
 *
 * `schema` is a field of a prepared definition. `undefined` stands for a name
 * the definition does not declare, which accepts nothing. A schema that was
 * never prepared throws; see `validationOf`.
 *
 * Whether a field admits `null` is this same question, asked where it is
 * needed: `accepts(schema, null)`. It is not read off the schema's keywords,
 * because `Type.Any()` admits `null` and a refinement may refuse it or throw
 * on it. Asking can invoke callbacks, and `inputIssues` runs `Check` and then
 * `Errors`, so a callback may be called more than once for one read. When and
 * how often is not promised: a callback is a deterministic predicate over the
 * content it is given.
 */
export function accepts(
	schema: (TSchema & object) | undefined,
	value: unknown,
): boolean {
	if (schema === undefined) return false;
	const validation = validationOf(schema);
	return trySync({
		try: () => {
			const json = readable(validation, value);
			return isJsonSafe(json) && validation.validator.Check(json);
		},
		catch: () => Ok(false),
	}).data;
}

/**
 * Why a value fails {@link accepts}: that it is not JSON, TypeBox's own errors
 * with the paths that can be walked in the value, or that schema validation
 * threw. Empty when the value is accepted. An exception stays with this
 * field, so sibling fields and the source remain readable.
 *
 * `Check` decides validity. `Errors` only describes a failure, so a value
 * `Check` refuses is an issue even when `Errors` reports nothing.
 *
 * `name` is the declaration key, held for the diagnostics. The subject names
 * the field and not its editor: a hint never changes what conformance reports.
 */
function fieldIssues(
	name: string,
	schema: TSchema & object,
	value: unknown,
): ConformanceIssue[] {
	const validation = validationOf(schema);
	const subject = `${name} does not conform`;
	return trySync({
		try: (): ConformanceIssue[] => {
			const json = readable(validation, value);
			if (!isJsonSafe(json))
				return [{ field: name, message: `${subject}: must be a JSON value` }];
			if (validation.validator.Check(json)) return [];
			const errors = validation.validator.Errors(json);
			if (errors.length === 0) return [{ field: name, message: subject }];
			return errors.map((error) => {
				const path = verifiedPointer(json, error.instancePath);
				return path === undefined
					? { field: name, message: `${subject}: ${error.message}` }
					: {
							field: name,
							path,
							message: `${subject} at ${path}: ${error.message}`,
						};
			});
		},
		catch: () =>
			Ok([{ field: name, message: `${subject}: schema validation threw` }]),
	}).data;
}

/**
 * Read a stored payload through prepared fields: the declared fields that
 * validated, beside the issues of the ones that did not.
 *
 * Every declared field is required and checked by itself, so a field that
 * fails does not take a valid one with it. A conforming value is the payload's
 * own object. A key the fields do not declare is neither conforming nor an
 * issue.
 */
export function conformance(
	fields: FieldMap,
	payload: Readonly<Record<string, unknown>>,
): Conformance {
	const conforming: JsonObject = {};
	const issues: ConformanceIssue[] = [];
	for (const [fieldName, schema] of Object.entries(fields)) {
		if (!Object.hasOwn(payload, fieldName)) {
			issues.push({ field: fieldName, message: `${fieldName} is missing` });
			continue;
		}
		const found = fieldIssues(fieldName, schema, payload[fieldName]);
		if (found.length === 0)
			conforming[fieldName] = payload[fieldName] as JsonValue;
		else issues.push(...found);
	}
	return { conforming, issues };
}

/**
 * Check supplied values against prepared fields and, for a complete row,
 * required field presence. An undeclared key is an issue here.
 */
export function inputIssues(
	fields: FieldMap,
	values: Readonly<Record<string, unknown>>,
	{ complete }: { complete: boolean },
): ConformanceIssue[] {
	const issues: ConformanceIssue[] = [];
	for (const [key, value] of Object.entries(values)) {
		// An own entry only: a prototype declares nothing.
		const schema = Object.hasOwn(fields, key) ? fields[key] : undefined;
		if (schema === undefined)
			issues.push({ field: key, message: `${key} is not declared` });
		else issues.push(...fieldIssues(key, schema, value));
	}
	if (complete)
		for (const fieldName of Object.keys(fields))
			if (!Object.hasOwn(values, fieldName))
				issues.push({ field: fieldName, message: `${fieldName} is missing` });
	return issues;
}

/**
 * A deeply frozen copy of a value's arrays and plain objects, for a native
 * callback to read. `undefined`, which is not JSON, when the value holds any
 * other kind of object: a class instance that is not an array is refused,
 * never flattened. An array subclass passes `Array.isArray`, as it does in
 * `isJsonSafe`, and its copy is a plain array.
 *
 * The caller's value is read and never frozen. The copy keeps what makes the
 * value JSON or not: each object's prototype (plain or null), own enumerable
 * keys including `__proto__`, array order, and shared nodes, which stay
 * shared. A cycle is copied as a cycle, and `isJsonSafe` refuses the copy
 * before a validator sees it.
 *
 * The copy holds stored JSON content: array elements and own enumerable
 * string-keyed properties, each read once. A non-enumerable, accessor,
 * symbol-keyed, or inherited property is outside that. A keyword-only schema
 * reads the caller's value and can see one; a schema with a callback reads
 * this copy and cannot, so the two can differ on such a value. Nothing
 * normalizes it away.
 *
 * It walks with its own stack, like `isJsonSafe`, so depth has no limit.
 * `structuredClone` recurses and overflows on a deep value.
 */
function frozenCopy(value: unknown): unknown {
	const copies = new Map<object, object>();
	const pending: object[] = [];
	let copyable = true;
	const copyOf = (node: unknown): unknown => {
		if (typeof node !== 'object' || node === null) return node;
		const known = copies.get(node);
		if (known !== undefined) return known;
		if (!Array.isArray(node) && !isPlainObject(node)) {
			copyable = false;
			return undefined;
		}
		const copy = Array.isArray(node)
			? []
			: Object.create(Object.getPrototypeOf(node));
		copies.set(node, copy);
		pending.push(node);
		return copy;
	};
	const root = copyOf(value);
	while (copyable && pending.length > 0) {
		const node = pending.pop() as object;
		const copy = copies.get(node);
		if (Array.isArray(node)) {
			for (let index = 0; index < node.length; index++)
				(copy as unknown[]).push(copyOf(node[index]));
			continue;
		}
		// Defined, not assigned: assigning `__proto__` would set the prototype.
		for (const key of Object.keys(node))
			Object.defineProperty(copy, key, {
				value: copyOf((node as Record<string, unknown>)[key]),
				enumerable: true,
			});
	}
	if (!copyable) return undefined;
	for (const copy of copies.values()) Object.freeze(copy);
	return root;
}

/**
 * A native copy of a declared schema, frozen where it is a copy: the field a
 * prepared definition holds, and what its validator is compiled from.
 *
 * `Memory.Clone` is TypeBox's own clone. It copies own string-keyed data
 * properties, hidden ones included, so every native constraint and the
 * `x-field` hint come along. It passes a function through by reference. It
 * also passes through, whole and by reference, any node that has a `~guard`
 * key: the guard and every keyword beside it, at the root or nested. Those
 * stay as they are here, unfrozen, because freezing one would freeze the
 * author's object. So a field with a `~guard` node is not held still by this
 * snapshot at that node, and editing it after preparation is the author's to
 * avoid. Symbol keys, accessors, and what a callback or a guard closes over
 * are also outside what it holds.
 *
 * `callbacks` is whether the walk met a function, which is what `Type.Refine`
 * stores under `~refine`, or a `~guard` node. TypeBox calls those with the
 * value being validated, so the field validates a copy. Any function counts.
 * A codec's `decode` and `encode` are functions that `Check` and `Errors`
 * never call, so a codec costs a copy and transforms nothing here.
 */
function snapshot(declared: object): {
	schema: TSchema & object;
	callbacks: boolean;
} {
	const schema = Memory.Clone(declared) as TSchema & object;
	let callbacks = false;
	const pending: unknown[] = [schema];
	while (pending.length > 0) {
		const value = pending.pop();
		if (typeof value === 'function') callbacks = true;
		if (typeof value !== 'object' || value === null) continue;
		if ('~guard' in value) {
			callbacks = true;
			continue;
		}
		if (Object.isFrozen(value)) continue;
		if (!Array.isArray(value) && !isPlainObject(value)) continue;
		Object.freeze(value);
		for (const key of Object.getOwnPropertyNames(value))
			pending.push(Object.getOwnPropertyDescriptor(value, key)?.value);
	}
	return { schema, callbacks };
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

/**
 * The pointer TypeBox reported, when it names a location inside `value`.
 * `undefined` for the value itself and for a path that cannot be walked.
 */
function verifiedPointer(
	value: unknown,
	instancePath: string,
): string | undefined {
	if (!instancePath.startsWith('/')) return undefined;
	let node = value;
	for (const segment of instancePath.slice(1).split('/')) {
		if (Array.isArray(node)) {
			if (!/^(0|[1-9][0-9]*)$/.test(segment) || Number(segment) >= node.length)
				return undefined;
			node = node[Number(segment)];
		} else if (typeof node === 'object' && node !== null) {
			// An unescaped key holding `/` or `~` could split into these segments.
			if (
				!Object.hasOwn(node, segment) ||
				Object.keys(node).some((key) => /[/~]/.test(key))
			)
				return undefined;
			node = (node as Record<string, unknown>)[segment];
		} else return undefined;
	}
	return instancePath;
}
