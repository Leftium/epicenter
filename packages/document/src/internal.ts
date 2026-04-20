/**
 * Internal subpath — not part of `@epicenter/document`'s public API.
 *
 * Exports the `create*Helper` factories that wrap a pre-constructed LWW
 * store with a typed helper surface. External consumers should use
 * `attachTable` / `attachKv` / `attachAwareness` from the package root —
 * those are the public, Y.Doc-wiring entry points.
 *
 * `@epicenter/workspace` reaches in here because it constructs its own
 * encrypted store and needs the helper logic without the Y.Doc wiring.
 */
export { createTableHelper } from './attach-table.js';
export { createKvHelper } from './attach-kv.js';
export { createAwarenessHelper } from './attach-awareness.js';
