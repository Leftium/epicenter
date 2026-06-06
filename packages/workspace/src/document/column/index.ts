/**
 * Public surface of the `defineTable` column primitives: the `FlatJsonTSchema`
 * constraint plus the workspace's substrate-only builders (`nullable`, `ianaTimeZone`).
 * The portable kinds are authored via `field.*` from `@epicenter/field` directly.
 *
 * Columns may be authored with `field.*`, `nullable`, or raw `Type.X()`; `FlatJsonTSchema`
 * enforces safety regardless of which call site produced the schema.
 */

export type { ColumnError, FlatJsonTSchema } from './constraint';
export { ianaTimeZone, nullable } from './sugar';
