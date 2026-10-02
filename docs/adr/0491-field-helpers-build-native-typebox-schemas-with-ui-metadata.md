# 0491. Field helpers build native TypeBox schemas with UI metadata

- **Status:** Proposed
- **Date:** 2026-10-02
- **Amends:** [ADR-0255](0255-data-definitions-use-one-data-first-public-vocabulary.md) at the refusal of inert JSON Schema `default` annotations. Initialization and recovery remain application-owned.

## Context

First-party App and Folder declarations need generic editors, and their values
need TypeBox validation, including nested payload schemas and native
refinements. A closed schema recognizer duplicated those checks and discarded
hidden constraints when a schema was copied as JSON.

An earlier draft of this record kept a helper-only field vocabulary: a hidden
provenance mark, refused at compile time when absent, and editor metadata that
repeated select options and nullability beside the schema. That made the hint a
gate on what could be stored, gave the schema and the metadata two places to
disagree, and put a refinement callback inside a helper, so a helper schema
did not survive JSON. No data or caller depended on it.

## Decision

**A field declaration is any native `TSchema`.**
`FieldMap` in `packages/definition/src/declaration.ts` takes one, as an object:
TypeBox's `TSchema` is an empty interface, so a primitive is excluded by type
and refused by `compileData`. An
unannotated `Type.Object`, `Type.Enum`, `Type.Any`, or `Type.Refine` is a
field. Nothing records which function built a schema, and a schema read back
from JSON is admitted like any other. The schema alone decides whether a value
conforms.

**`x-field` is an optional, serialized editor hint that validates nothing.**
It holds a `kind`, and a reference additionally holds its `target` table. The
editor is resolved by `fieldEditorOf` in `packages/definition/src/field/editor.ts`
into `DataField.editor`: `{ kind, nullable }`, plus `options` for a select and
`target` for a reference. Options are the schema's declared `enum` or
`items.enum`; other keywords and native refinements may narrow what the check
admits, and nothing filters the list by running them. Nullability is whether
the compiled field admits `null`, which the caller of `fieldEditorOf` supplies.

**Only a plain union with `null` is read through.**
A union of exactly `{ type: 'null' }` and one other schema, with only
annotations beside its `anyOf`, takes its other member's hint when it has no
`x-field` of its own. That is what `field.nullable` builds. A union with its own
`x-field` uses that one, and an unusable one is not replaced by the member's.

**A hint that cannot be honored resolves to the JSON editor.**
That covers a schema with no hint, an unknown kind, a malformed hint, a
reference target that is not a usable table name, and a hint naming a widget
whose shape the schema does not have. The shape checks ask a keyword or two of
one schema node and err toward JSON: a node with a composition keyword
(`anyOf`, `allOf`, `oneOf`, `not`, `if`, `then`, `else`, `$ref`) and a string
`enum` beside a non-string `type` both get the JSON editor. They are not a
schema recognizer, and no editor is guessed for a schema without a hint.

**`field.*` helpers add portable keywords and editor hints to native schemas.**
Helpers introduce no refinement callback or codec. Keyword-based constraints
and hints survive `JSON.stringify` and `JSON.parse`; native callbacks supplied
as inputs remain local. `field.json(inner)` is a copy
of `inner` with the JSON hint. `field.nullable(inner)` is
`Type.Union([inner, Type.Null()])` over any native schema. Helpers keep their
narrow option guards, so an option cannot replace a `type`, a `format`, or the
hint. There is no `maxBytes` option.

**One JSON-safety check runs before native validation, for every field.**
`compileData` holds each value to `isJsonSafe` before the compiled validator
sees it, in `check`, `errors`, `conformance`, and `inputIssues`. The check
refuses non-JSON values and cycles and sets no depth or width limit. Folder KV
keeps its separate budget; frontmatter imposes no fixed depth or width budget.
A value that is JSON gets TypeBox's own errors and paths. A native validator
exception fails only that field with `schema validation threw`, so sibling
fields and source remain readable.

**`compileData` owns one frozen snapshot of each declared field.**
It clones own string-keyed data properties with TypeBox's `Memory.Clone`,
freezes the copied plain objects and arrays, and compiles that. The editor is
resolved from the same snapshot. Native composition happens before
compilation. Table and field names come from declaration keys.

**A native `default` annotation is admitted and inert.**
Validation reads a value and never fills or changes it, so no default is
applied anywhere: a missing declared field and a missing required property are
still issues. Helpers do not take `default` as an option.

**A storage does not gate admission on a hint.**
Folder accepts a reference field as the string schema it is. No storage checks
that a reference's target exists, and renaming or deleting a row repairs
nothing that names it.

## Consequences

The provenance mark, the helper-only declaration type, and duplicated metadata
are gone. An author can edit a helper's schema natively before compilation, and
the check and the editor follow the edited schema together.

JSON safety is a property of a compiled field, not of a schema. A helper
schema validated directly with TypeBox's `Compile` admits what its keywords
admit: `field.json(Type.Any())` checked that way admits a `Date`.

A JSON-safe value is not the same thing as a serializable schema. A native
`Type.Refine` callback or a codec added by an author runs locally and is not
part of the schema's JSON form. No exporter or dialect importer exists.

A reference is an editor intent over a string. Its target is held to the table
name grammar because consumers print it. Identifiers may dangle.

A refinement that throws when given `null` fails compilation, because
nullability is asked of the compiled field at the declaration.

## Considered alternatives

- A `{ kind, schema }` field wrapper duplicates the native schema boundary.
- A hidden provenance mark required at compile time makes an editor hint a
  storage gate and refuses schemas that validate correctly.
- Metadata that carries select options and nullability gives the schema and
  the hint two places to disagree after a native edit.
- Inferring a rich editor from an unannotated schema needs a recognizer and
  changes an editor when a schema is refactored.
- Refusing a schema that declares a `default` needs a walker over a closed list
  of schema-holding keywords, and guards against an initialization that no code
  performs.
- A resolver that asks a validator for nullability itself runs a second
  validator beside the compiled one.
- A native conditional (`if`, `then`, `else`) that gates a payload on JSON
  safety covers only `field.json`, hides a callback in the schema, and reports
  a failed payload as one generic `then` error.
- A refinement after a recursive schema validates too late to reject a cycle.
- A byte ceiling on a string helper needs a callback, which does not survive
  JSON. Storage limits belong to the storage that has them.
- Freezing helper outputs interferes with native composition and assigns schema
  ownership before the definition is compiled.
