export type { FieldToArktype } from './converters/to-arktype.js';
export {
	fieldToArktype,
	tableToArktype,
} from './converters/to-arktype.js';
export type { FieldToYjsArktype } from './converters/to-arktype-yjs.js';
export {
	fieldToYjsArktype,
	tableToYjsArktype,
} from './converters/to-arktype-yjs.js';
export type { TableDefinitionsToDrizzle } from './converters/to-drizzle.js';
export {
	convertTableDefinitionsToDrizzle,
	toSqlIdentifier,
} from './converters/to-drizzle.js';

export type { FieldToTypebox } from './converters/to-typebox.js';
export {
	fieldsToTypebox,
	fieldToTypebox,
} from './converters/to-typebox.js';
export type { DateIsoString, TimezoneId } from './fields/datetime.js';
export { DateTimeString } from './fields/datetime.js';
export {
	boolean,
	date,
	id,
	integer,
	json,
	real,
	richtext,
	select,
	setting,
	table,
	tags,
	text,
} from './fields/factories.js';
export { isNullableField } from './fields/helpers.js';
export type { Guid, Id } from './fields/id.js';
export { generateGuid, generateId } from './fields/id.js';
export {
	DATE_TIME_STRING_REGEX,
	ISO_DATETIME_REGEX,
	TIMEZONE_ID_REGEX,
} from './fields/regex.js';
export type {
	// New field type names (preferred)
	BooleanField,
	DateField,
	IdField,
	IntegerField,
	JsonField,
	RealField,
	RichtextField,
	SelectField,
	TagsField,
	TextField,

	// Legacy type aliases (deprecated, kept for backwards compatibility)
	BooleanFieldSchema,
	DateFieldSchema,
	FieldSchema,
	IdFieldSchema,
	IntegerFieldSchema,
	JsonFieldSchema,
	RealFieldSchema,
	RichtextFieldSchema,
	SelectFieldSchema,
	TagsFieldSchema,
	TextFieldSchema,

	// Common types
	CellValue,
	Field,
	FieldById,
	FieldIds,
	FieldMetadata,
	FieldOptions,
	FieldType,
	Icon,
	IconType,
	PartialRow,
	Row,
	TableDefinition,

	// KV types
	KvField,
	KvValue,

	// Deprecated KV types (kept for backwards compatibility)
	KvDefinition,
	KvDefinitionMap,
	KvMap,

	// Deprecated table types (kept for backwards compatibility)
	TableDefinitionMap,
} from './fields/types.js';
export { createIcon, isIcon, parseIcon } from './fields/types.js';
export { standardSchemaToJsonSchema } from './standard/to-json-schema.js';
export type {
	StandardJSONSchemaV1,
	StandardSchemaV1,
	StandardSchemaWithJSONSchema,
	StandardTypedV1,
} from './standard/types.js';
