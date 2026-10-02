/**
 * Compile developer declarations into read lenses.
 *
 * A field is a native TypeBox schema, so preparing one is `Compile`. The
 * compiler adds what a single schema cannot say: usable names, that a value is
 * JSON, and a per-field conformance read. It also resolves each field's
 * editor, which no check reads.
 *
 * Reading is all it does. `check` and `issues` never change the value they are
 * given, so a `default` annotation in a schema is inert: nothing fills a
 * missing value, and a missing declared field is still an issue.
 */

import { Compile } from 'typebox/compile';
import { Memory } from 'typebox/system';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result, trySync } from 'wellcrafted/result';
import { DATA_ADDRESS_CEILINGS, isDataId, isTableName } from './addresses.js';
import {
	type ConformanceIssue,
	type DataDefinition,
	type DataField,
	KV_ROOT,
	RESERVED_TABLE_NAMES,
	type TableBody,
	type TableDeclaration,
} from './declaration.js';
import { fieldEditorOf } from './field/editor.js';
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
	conformance(payload: Readonly<Record<string, unknown>>): Conformance;
	/** Check supplied fields and, for a complete row, required field presence. */
	inputIssues(
		values: Readonly<Record<string, unknown>>,
		options: { complete: boolean },
	): ConformanceIssue[];
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
		if (!isPlainObject(declared)) {
			return DataDefinitionParseError.UnrecognizedField({
				table: tableName,
				field: fieldName,
				reason: 'a field is a TypeBox schema',
			});
		}
		const prepared = trySync({
			try: () => compileField(fieldName, declared),
			catch: (cause) =>
				DataDefinitionParseError.UnrecognizedField({
					table: tableName,
					field: fieldName,
					reason: String(cause),
				}),
		});
		if (prepared.error) return prepared;
		compiled.set(fieldName, prepared.data);
	}
	return Ok(
		Object.freeze({
			name: tableName,
			fields: compiled,
			conformance(payload): Conformance {
				const conforming: JsonObject = {};
				const issues: ConformanceIssue[] = [];
				for (const [fieldName, field] of compiled) {
					if (!Object.hasOwn(payload, fieldName)) {
						issues.push({
							field: fieldName,
							message: `${fieldName} is missing`,
						});
						continue;
					}
					const found = field.issues(payload[fieldName]);
					if (found.length === 0)
						conforming[fieldName] = payload[fieldName] as JsonValue;
					else issues.push(...found);
				}
				return { conforming, issues };
			},
			inputIssues(values, { complete }) {
				const issues: ConformanceIssue[] = [];
				for (const [key, value] of Object.entries(values)) {
					const field = compiled.get(key);
					if (field === undefined)
						issues.push({ field: key, message: `${key} is not declared` });
					else issues.push(...field.issues(value));
				}
				if (complete)
					for (const fieldName of compiled.keys())
						if (!Object.hasOwn(values, fieldName))
							issues.push({
								field: fieldName,
								message: `${fieldName} is missing`,
							});
				return issues;
			},
		}),
	);
}

/**
 * One field's read of a value: is it JSON, and then TypeBox's compiled
 * validator. `check` and `issues` are that read, and a table's `conformance`
 * and `inputIssues` call `issues`. Throws when TypeBox cannot compile the
 * schema.
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
 * recursion: that field then fails its check and reports the exception, so
 * sibling fields and the source remain readable.
 *
 * `Check` decides validity. `Errors` only describes a failure, so a value
 * `Check` refuses is an issue even when `Errors` reports nothing.
 *
 * The declaration probes nullability before a storage opens it. That probe can
 * invoke callbacks with `null`, and `issues` runs `Check` and then
 * `Errors`, so a callback may be called more than once for one read. When and
 * how often is not promised: a callback is a deterministic predicate over the
 * content it is given.
 *
 * `name` is the declaration key, held for the diagnostics. The compiled field
 * does not carry it: the `fields` map key is the name.
 */
function compileField(name: string, declared: object): DataField {
	const schema = snapshot(declared);
	const validator = Compile(schema);
	const check = (value: unknown): boolean =>
		trySync({
			try: () => isJsonSafe(value) && validator.Check(value),
			catch: () => Ok(false),
		}).data;
	// The subject names the field and not its editor: a hint never changes
	// what conformance reports.
	const subject = `${name} does not conform`;
	const issues = (value: unknown): readonly ConformanceIssue[] =>
		trySync({
			try: (): ConformanceIssue[] => {
				if (!isJsonSafe(value))
					return [{ field: name, message: `${subject}: must be a JSON value` }];
				if (validator.Check(value)) return [];
				const errors = validator.Errors(value);
				if (errors.length === 0) return [{ field: name, message: subject }];
				return errors.map((error) => {
					const path = verifiedPointer(value, error.instancePath);
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
	return Object.freeze({
		editor: fieldEditorOf(schema, validator.Check(null)),
		schema,
		check,
		issues,
	});
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
