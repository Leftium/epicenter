# 0491. Field helpers build native TypeBox schemas with UI metadata

- **Status:** Accepted
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
editor is resolved in `packages/definition/src/field/editor.ts` into
`DataField.editor`: `{ kind, nullable }`, plus `options` for a select and
`target` for a reference. The resolver is internal to the package: a compiled
field's `editor` is the only public reading. Options are the schema's declared
`enum` or `items.enum`; other keywords and native refinements may narrow what
the check admits, and nothing filters the list by running them.

**Nullability is editor information, not a gate.**
It is whether the compiled field's `check` admits `null`. A validator that
throws on `null` does not admit it, so that field compiles as not nullable and
a stored `null` fails where it is read. A failure to compile the native schema remains a definition error.

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
`enum` beside a non-string `type` both get the JSON editor. A formatted kind
also needs a compatible `format`: `uri` for `url`, `date` for `date`, and
`date-time` for `instant` and `datetime`, the formats the helpers set. A string
schema that declares that format, or none, fits; one that declares another
(`format: 'email'` under a `date` hint) gets the JSON editor. `string` and
`reference` name no format. They are not a schema recognizer, none asks whether
a schema can be satisfied, and no editor is guessed for a schema without a
hint.

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
sees it, in `check`, `issues`, `conformance`, and `inputIssues`. The check
refuses non-JSON values and cycles and sets no depth or width limit. Folder KV
keeps its separate budget; frontmatter imposes no fixed depth or width budget.
A value that is JSON gets TypeBox's own errors and paths. A native validator
exception fails only that field with `schema validation threw`, so sibling
fields and source remain readable.

**A compiled field owns its diagnostics.**
`DataField` has `check(value)` and `issues(value)`, which returns structured
`{ field, path?, message }` issues. `conformance` and `inputIssues` keep their
policies and report what `issues` returns; there is no second, string-only
error list and no parallel table of validators. TypeBox's compiled `Check`
decides validity. `Errors` describes a failure and may be capped or empty, so
a value `Check` refuses is always at least one issue.

**Validation reads a value and never writes it, native callbacks included.**
TypeBox calls a `Type.Refine` callback and a `~guard` with the value being
validated, and a callback that wrote to it changed the caller's source and
could make a conforming value stop being JSON. The schema snapshot walk
records whether a field holds a function or a `~guard`. Such a field validates
a private, deeply frozen copy; a field of keywords alone, which is every
unrefined helper, reads the value in place and copies nothing. The copy is
iterative, so depth stays unlimited, and it keeps null prototypes, an own
`__proto__` key, arrays, and shared nodes. A class instance that is not an
array is refused rather than flattened, and a cycle is refused before any
validator runs. An array subclass passes `Array.isArray`, as it does in
`isJsonSafe`, and its copy is a plain array. The caller's value is never
frozen. A refused write throws in strict code and fails that field like any
other throwing callback.

The guarantee is about the argument a callback is given, and only that. A
callback is a deterministic predicate over content. Compilation probes
`null` to learn nullability, which can invoke callbacks. A read may invoke them
more than once; timing and call count are not guaranteed. Closure state, state
a guard object keeps, side effects, and nondeterminism are the author's
obligations. Object identity is outside the stored JSON content contract.
This is not a sandbox.

The supported values are stored JSON content: array elements and own
enumerable string-keyed data properties. Non-enumerable, accessor, and
inherited properties are outside that contract. A keyword-only field reads the
caller's value and a callback field reads the enumerable copy, so the two can
answer differently for such a value: `Type.Object({ hidden: Type.Number() })`
admits an object with a non-enumerable `hidden`, and the same schema under
`Type.Refine` refuses it. This is a documented limit, not a normalization the
compiler enforces.

The shared compiler owns this protection, so App and Folder need no callback
protection of their own. Folder still owns the copies it makes for other
reasons: of input it holds across an await, and of the immutable snapshots it
publishes.

**`compileData` owns one snapshot of each declared field, frozen where it is a copy.**
It clones own string-keyed data properties with TypeBox's `Memory.Clone`,
freezes the copied plain objects and arrays, and compiles that. The editor is
resolved from the same snapshot. Native composition happens before
compilation. Table and field names come from declaration keys, and a compiled
field does not repeat its name: the `fields` map key is the only one.

The snapshot is not a full freeze. `Memory.Clone` keeps a function by
reference, and it keeps any node with a `~guard` key by reference whole, with
every keyword beside the guard, at the root or nested. Those nodes and the
guard's own state stay the author's objects, unfrozen and outside the
snapshot.

**A codec is carried and never run.**
A field's reads call TypeBox's `Check` and `Errors`, which do not decode or
encode. Codec metadata stays on the schema and is not portable as JSON, and no
value is transformed here.

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
`Type.Refine` callback added by an author runs locally, a codec is carried
without running, and neither is part of the schema's JSON form. No exporter or
dialect importer exists.

A reference is an editor intent over a string. Its target is held to the table
name grammar because consumers print it. Identifiers may dangle.

A refinement that throws when given `null` no longer fails compilation. The
schema may admit other values, so refusing the definition over
optional editor information rejected more than it protected.

A field with a native callback pays one copy of each value per read. Fields
built from keywords pay nothing.

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
- A public `fieldEditorOf` export had no caller outside the compiler, and its
  caller-supplied nullability let an editor disagree with the compiled check.
- A string-only `DataField.errors` beside the table's structured issues kept
  two diagnostic paths over one validator.
- A `name` on each compiled field repeated its key in the `fields` map. Its one
  reader, the checkout guide, sorts and prints the map's entries.
- Copying non-enumerable, accessor, or inherited properties into the callback's
  copy, or refusing a value that has one, adds machinery or a stricter JSON gate
  for values no storage produces.
- Freezing the caller's value in place protects it from a callback and takes
  away the caller's right to edit its own object.
- `structuredClone` for the callback's copy recurses, so it overflows on a deep
  value and would add the depth ceiling `isJsonSafe` avoids.
- Copying every value, callback or not, charges keyword-only fields for a risk
  they do not have.
- Deciding whether a hinted schema is satisfiable (a `format` against a
  `pattern`, say) is schema analysis. The format rule compares one keyword.
- A native conditional (`if`, `then`, `else`) that gates a payload on JSON
  safety covers only `field.json`, hides a callback in the schema, and reports
  a failed payload as one generic `then` error.
- A refinement after a recursive schema validates too late to reject a cycle.
- A byte ceiling on a string helper needs a callback, which does not survive
  JSON. Storage limits belong to the storage that has them.
- Freezing helper outputs interferes with native composition and assigns schema
  ownership before the definition is compiled.
