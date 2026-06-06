/**
 * `@epicenter/field` — the closed field-type vocabulary.
 *
 * Two halves over ONE wire-form:
 * - `field.*` builders (authoring) construct a schema in the recognized form.
 * - `recognize` (recognition) classifies a stored schema back to its kind.
 *
 * They are inverses: `recognize` of a serialized `field.X(...)` is kind `X`.
 * Emptiness (`nullable`) and arbitrary `json` are NOT here; they are substrate
 * policy each consumer layers on at its own edge.
 */

export { field } from './builders';
export { DateTimeString } from './datetime-string';
export {
	compile,
	type Field,
	type FieldOf,
	type Kind,
	KINDS,
	META_BY_KIND,
	recognize,
	type Recognized,
	type SchemaOf,
	storageOf,
} from './field';
