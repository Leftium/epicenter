/**
 * Matter's view of the closed field vocabulary, re-exported from the shared leaf
 * `@epicenter/field`. The nine kinds, `recognize`, and `compile` are no longer
 * matter-specific: the workspace authors the SAME schemas through `column.*`, and
 * both directions round-trip over one wire-form. `$lib/core/field` stays matter's
 * stable import seam, so the grid, conformance, sqlite projector, and the per-kind
 * widgets keep importing from here.
 *
 * Matter's SUBSTRATE POLICY stays in matter, expressed by how it USES this
 * vocabulary rather than by extending it:
 *
 *   everything-required  matter adds NO `nullable` wrapper (the workspace's
 *                        `column.nullable` is the opposite policy); "must have
 *                        content" is a value constraint (`minLength`), not a flag.
 *   no json              an arbitrary-JSON shape is outside the palette, so
 *                        `recognize` returns null and the field degrades to raw.
 *   per-kind widgets     the Svelte components in `components/fields/` map each
 *                        `Kind` to its editor; the compiler forces one per kind.
 *
 * The leaf stays policy-free; matter's policy is the absence of the workspace's
 * wrappers, plus the widget registry that lives beside this seam.
 */

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
} from '@epicenter/field';
