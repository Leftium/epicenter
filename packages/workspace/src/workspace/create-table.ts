/**
 * `createTable` is a workspace-facing alias for `tableHelperOver` from
 * `@epicenter/document`. Kept under the legacy name so existing callers
 * (tests, `create-tables.ts`) keep working — the implementation now lives
 * in one place.
 *
 * The first argument is typed as any LWW-shaped store. `@epicenter/workspace`
 * passes its `EncryptedYKeyValueLww` wrapper, which is structurally a
 * superset of the `LwwStoreLike` shape the helper expects.
 */

export { tableHelperOver as createTable } from '@epicenter/document';
