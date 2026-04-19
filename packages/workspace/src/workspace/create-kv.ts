/**
 * `createKv` is a workspace-facing alias for `kvHelperOver` from
 * `@epicenter/document`. Kept under the legacy name so existing callers
 * (tests, benchmarks) keep working — the implementation now lives in
 * one place.
 *
 * The first argument is typed as any LWW-shaped store. `@epicenter/workspace`
 * passes its `EncryptedYKeyValueLww` wrapper, which is structurally a
 * superset of the `KvStoreLike` shape the helper expects.
 */

export { kvHelperOver as createKv } from '@epicenter/document';
