/**
 * `createAwareness` is a workspace-facing alias for `awarenessHelperOver`
 * from `@epicenter/document`. Kept under the legacy name so existing tests
 * keep working — the implementation now lives in one place.
 *
 * The caller owns the `Awareness` instance; this only wraps it with the
 * typed helper.
 */

export { awarenessHelperOver as createAwareness } from '@epicenter/document';
