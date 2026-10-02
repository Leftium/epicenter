/**
 * `@epicenter/definition`: inert data-definition vocabulary and its compiler.
 *
 * A storage imports this to read a declaration; it acquires nothing and knows
 * no storage. `@epicenter/app` binds the body conversion to its Yjs stores,
 * and `@epicenter/folder` refuses one.
 */

export * from './addresses.js';
export {
	type Conformance,
	type ConformanceIssue,
	compileData,
	DataDefinitionParseError,
	type ParsedDataDefinition,
	type ParsedTable,
} from './compile.js';
export {
	type CreateRowOf,
	type DataDefinition,
	type DataField,
	type DeclaredMark,
	type DeclaredTable,
	type FieldMap,
	field,
	KV_ROOT,
	type KvOf,
	RESERVED_TABLE_NAMES,
	type RowOf,
	type TableBody,
	type TableDeclaration,
} from './declaration.js';
export {
	type DefineTable,
	defineTable,
	type ValidateFields,
} from './define.js';
export {
	CalendarDateString,
	DateTimeString,
	FIELD_KEYWORD,
	type FieldMetadata,
	type FieldSchema,
	fieldMetadataOf,
	InstantString,
	jsonValue,
	type Kind,
} from './field/index.js';
export * from './json.js';
