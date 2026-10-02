/**
 * `@epicenter/definition/field`: the field helpers and the branded string
 * values some of them hold.
 *
 * A field is a native TypeBox schema annotated with the editor it gets; see
 * `./builders` and `./metadata`.
 */

export { field, jsonValue } from './builders.js';
export { CalendarDateString } from './calendar-date-string.js';
export { DateTimeString } from './datetime-string.js';
export { InstantString } from './instant-string.js';
export {
	FIELD_KEYWORD,
	type FieldMetadata,
	type FieldSchema,
	fieldMetadataOf,
	type Kind,
} from './metadata.js';
