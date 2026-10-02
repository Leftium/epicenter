/** Inert data-definition vocabulary. Runtime store entrypoints live beside it. */

export {
	type AddressByteCeilings,
	CalendarDateString,
	DATA_ADDRESS_CEILINGS,
	DateTimeString,
	FIELD_KEYWORD,
	type FieldMetadata,
	type FieldSchema,
	fieldMetadataOf,
	InstantString,
	isDataId,
	isRowId,
	isTableName,
	jsonValue,
	type Kind,
	SQLITE_UNUSABLE_AS_RELATION_NAME,
} from '@epicenter/definition';
export { plainText } from './body.js';
export {
	type Conformance,
	type ConformanceIssue,
	compileData,
	DataDefinitionParseError,
	type ParsedDataDefinition,
	type ParsedTable,
} from './compile.js';
export {
	type BodyCodec,
	type CreateRowOf,
	type DataDefinition,
	type FieldMap,
	field,
	type KvOf,
	type RowOf,
	type TableDeclaration,
} from './declaration.js';
export { defineTable } from './define.js';
export * from './json.js';
