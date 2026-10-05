/** Inert data-definition vocabulary. Runtime store entrypoints live beside it. */

export {
	type AddressByteCeilings,
	CalendarDateString,
	type Conformance,
	type ConformanceIssue,
	DATA_ADDRESS_CEILINGS,
	DataDefinitionParseError,
	DateTimeString,
	FIELD_KEYWORD,
	type FieldEditor,
	type FieldHint,
	InstantString,
	isDataId,
	isJsonObject,
	isJsonValue,
	isRowId,
	isTableName,
	type JsonObject,
	type JsonValue,
	jsonValue,
	type Kind,
	prepareData,
	SQLITE_UNUSABLE_AS_RELATION_NAME,
} from '@epicenter/definition';
export { plainText } from './body.js';
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
