/**
 * Internal subpath — not part of `@epicenter/document`'s public API.
 *
 * Exports the `create*` factories that wrap a pre-constructed `ObservableKvStore`.
 * External consumers should use `attachTable` / `attachKv` from the package
 * root — those are the public Y.Doc-wiring entry points.
 *
 * `@epicenter/workspace` reaches in here because it constructs its own
 * encrypted store and needs the factory logic without the Y.Doc wiring.
 * Awareness has no analogous encrypted path, so there's no reason to export
 * `createAwareness` here.
 */
export { createTable } from './attach-table.js';
export { createKv } from './attach-kv.js';
export {
	AttachPrimitive,
	guardSingleton,
	guardSlot,
} from './reentrance-guard.js';
