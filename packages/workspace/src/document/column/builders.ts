/**
 * The workspace's substrate-only column builders: what `defineTable` authoring adds on
 * top of the shared `field.*` vocabulary (`@epicenter/field`).
 *
 * The portable kinds (`field.string`, `field.select`, `field.datetime`, `field.json`, ...)
 * come straight from the leaf and are authored as `field.*`. This module holds only the
 * two builders the closed vocabulary deliberately OMITS, because they are per-substrate
 * decisions rather than members of the shared field set:
 *
 * - `nullable(inner)` — `Type.Union([inner, Type.Null()])`, the emptiness AXIS. A CRDT row
 *   has a fixed shape and cannot omit a key, so emptiness is a `null` VALUE (matter, whose
 *   markdown substrate encodes emptiness as an ABSENT key, forbids it). It is not a kind:
 *   `recognize` returns null for a nullable wrapper, so it degrades to raw cross-substrate.
 * - `ianaTimeZone()` — a branded `iana-time-zone`-format string (brand `IanaTimeZone`),
 *   registered once at module load. Outside the closed palette, so it degrades to raw too.
 *
 * Both are exported standalone (re-exported from `@epicenter/workspace`), so apps author
 * `field.*` for the kinds and `nullable` / `ianaTimeZone` for the substrate policy, with no
 * `column` namespace. The `FlatJsonTSchema` constraint (in `./constraint`) still gates every
 * `defineTable` column, whether authored via `field.*`, `nullable`, or raw `Type.*`.
 */

import {
	type TNull,
	type TSchema,
	type TSchemaOptions,
	type TUnion,
	type TUnsafe,
	Type,
} from 'typebox';
import { Format } from 'typebox/format';
import {
	IANA_TIME_ZONE_FORMAT,
	IanaTimeZone,
} from '../../shared/iana-time-zone';

// Register the IANA timezone format once at module load. Skip if another
// caller already registered it (idempotent under hot-reload / repeated
// module evaluation).
if (!Format.Has(IANA_TIME_ZONE_FORMAT)) {
	Format.Set(IANA_TIME_ZONE_FORMAT, (value) => IanaTimeZone.is(value));
}

/**
 * The emptiness AXIS: `Type.Union([schema, Type.Null()])`, reading as "nullable inner"
 * instead of constructing the union by hand (TypeBox issue #989). This is the workspace's
 * substrate policy, NOT a field kind: a CRDT row has a fixed shape and cannot omit a key,
 * so emptiness is encoded as a `null` VALUE (matter, whose markdown substrate encodes
 * emptiness as an ABSENT key, forbids it). Exported standalone so apps author it alongside
 * `field.*` without the `column` namespace.
 */
export function nullable<S extends TSchema>(schema: S): TUnion<[S, TNull]> {
	return Type.Union([schema, Type.Null()]);
}

/**
 * IANA timezone identifier, branded as `IanaTimeZone`.
 *
 * The `iana-time-zone` format is registered once at module load via
 * `Format.Set`, using `Intl.DateTimeFormat` as the source of truth (any zone
 * the runtime accepts is valid; any zone it rejects is not). No hand-tuned
 * regex.
 */
export function ianaTimeZone(opts?: TSchemaOptions): TUnsafe<IanaTimeZone> {
	return Type.Unsafe<IanaTimeZone>(
		Type.String({ format: IANA_TIME_ZONE_FORMAT, ...opts }),
	);
}
