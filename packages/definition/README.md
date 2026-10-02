# @epicenter/definition

The declaration vocabulary every Epicenter storage reads: the field helpers,
table and KV declarations, the durable name grammars, and the compiler that
turns a declaration into field checks.

It is inert. Importing it acquires nothing, and it knows no storage. Its only
dependencies are `typebox` and `wellcrafted`.

```ts
import { compileData, defineTable, field } from '@epicenter/definition';
import { Type } from 'typebox';

const todos = defineTable({
  fields: {
    title: field.string(),
    due: field.nullable(field.instant()),
    estimate: Type.Object({ hours: Type.Number() }),
  },
});
```

## Who uses it

| Package | What it adds |
| --- | --- |
| `@epicenter/app` | `defineStore`, and a table body bound to a Yjs node (`BodyCodec`, `plainText()`). It re-exports this vocabulary from its root, `/field`, and `/definition`. |
| `@epicenter/folder` | `defineFolder`, which refuses a body conversion, because a folder's row body is the file's Markdown text. |

Both get the same `defineTable` brand, the same `RowOf`, `CreateRowOf`, and
`KvOf` lenses, and the same compiled field checks. Neither copies a validator.

## Why this name

The package holds what App already exported as `@epicenter/app/definition` and
`@epicenter/app/field`: the things a `DataDefinition` is made of and the
function that compiles one. Its import closure is those modules and nothing
else:

```text
src/field/        the field.* helpers, the editor hint, and its resolver (./field)
src/declaration   FieldMap, TableDeclaration, DataDefinition, DataField, row lenses
src/define        defineTable and the declared-table brand
src/compile       compileData, ParsedTable, conformance
src/addresses     data ID, table name, and row ID grammars
src/json          JsonValue and its guards
```

There is no store, schema migration, or query code here, so `definition` says
what it is more exactly than `schema`, `data`, or `core` would.

## A field is one native schema

A field is any native TypeBox schema. `Static<>` reads it, and TypeBox's
`Compile` decides whether a value conforms. A bare `Type.Object(...)`,
`Type.Enum(...)`, `Type.Any()`, or `Type.Refine(...)` is a field, in
`defineTable` and in `kv`, with the exact `Static<>` TypeBox gives it.

The `field.*` helpers are wrappers for the common cases. Each returns a native
schema and sets one enumerable keyword on it, `x-field`, which says which
editor the author meant:

```ts
field.select(['draft', 'published']);
// { enum: ['draft', 'published'], 'x-field': { kind: 'select' } }

field.reference('pages');
// { type: 'string', minLength: 1, 'x-field': { kind: 'reference', target: 'pages' } }
```

| Helper | Native schema | Hint kind |
| --- | --- | --- |
| `string`, `reference(table)` | `Type.String`; a reference is never empty | `string`, `reference` |
| `url`, `date`, `instant`, `datetime` | `Type.String` with a format | the helper's name |
| `number`, `integer`, `boolean` | `Type.Number`, `Type.Integer`, `Type.Boolean` | the helper's name |
| `select(options)`, `multiSelect(options)` | `Type.Enum`, `Type.Array(Type.Enum)` | `select`, `multiSelect` |
| `tags` | `Type.Array(Type.String())` | `tags` |
| `json(schema)` | a copy of `schema` | `json` |
| `nullable(schema)` | `Type.Union([schema, Type.Null()])` | none of its own |

Helpers take the options their types list (`title` and `description`
everywhere; length, range, and list bounds where they apply) and throw on any
other key, so an option cannot replace a `type`, a `format`, or the hint.
`default` is not among a helper's options.

A native schema may carry a `default` annotation, at its root or nested
(`Type.String({ default: 'untitled' })`). It is inert here. Validation never
fills or changes a value, so a missing declared field is still an issue, a
missing required property still fails, and no payload is initialized or
recovered from a default. An application that wants one applies it itself.

`field.json` and `field.nullable` take any native schema. `field.json(inner)`
adds no validation: it is `inner` with the JSON editor chosen, which matters
when `inner` carries a hint for another editor. `field.nullable(inner)` is the
native union, and `inner` keeps its hint as a member.

### The hint is not validation

`x-field` holds a `kind`, and a reference also holds its `target`. Nothing
else. It never changes what a field accepts: the same schema with no hint, a
wrong hint, or an unknown hint checks, reports errors, and conforms
identically.

Each compiled field has one resolved `editor`:

```ts
const kv = compileData(definition).data.kv;

kv.fields.get('status').editor;
// { kind: 'select', nullable: true, options: ['draft', 'published'] }
```

| Part | Where it comes from |
| --- | --- |
| `kind` | The hint, when the schema has that widget's shape. Otherwise `json`. |
| `nullable` | Whether the compiled field admits `null`. |
| `options` | The schema's declared `enum` for a select, `items.enum` for a multi-select. |
| `target` | The hint, for a reference, when it is a usable table name. |

`options` is the declared list. The check never admits a value outside it,
but another keyword or a native refinement on the same schema can refuse one
of them, and nothing filters the list by running those.

A field gets the JSON editor when:

- it has no hint: a bare `Type.Enum` is not a select, and nothing is guessed;
- the hint's kind is unknown or the hint is malformed;
- a reference's target is not a usable table name;
- the schema does not have the shape the named widget edits: a `string` hint
  on a number, a `select` hint with no string `enum`, or a string `enum`
  beside a `type` that is not `string`;
- the schema, or the item schema of a list, is composed: it has `anyOf`,
  `allOf`, `oneOf`, `not`, `if`, `then`, `else`, or `$ref`.

These are conservative checks of a keyword or two on one schema node, not a
schema recognizer. They err toward the JSON editor.

One composition is read through: a union of exactly `{ type: 'null' }` and one
other schema, with only annotations beside the `anyOf`. That is what
`field.nullable` builds, and the same union written with `Type.Union` reads
the same. When the union has no `x-field` of its own it takes its other
member's hint, so `field.nullable(field.select([...]))` is a nullable select.
A union that has its own `x-field` uses that one, and an unusable one gets the
JSON editor; it is not replaced by the member's. A validation keyword beside
the `anyOf`, such as a root `type`, also decides what the field admits, so that
union is not read through.

Read the resolved editor from a compiled field. The resolver is internal.

### What survives JSON

Helpers add portable keywords and editor hints, without introducing a
refinement callback or codec. A keyword-based schema read back through
`JSON.parse(JSON.stringify(schema))` compiles to the same checks, issues, and
editor. Constraints supplied as native callbacks remain local.

A native `Type.Refine` works wherever a schema is declared, including over a
helper (`Type.Refine(field.string(), ...)`), and runs locally. Its callback is
a function, so it is not in the schema's JSON form. The same holds for a
codec. A declaration that uses either cannot be serialized faithfully. This
package has no exporter and no importer for other JSON Schema dialects.

A spread (`{ ...field.string() }`) keeps the enumerable keywords and drops any
hidden refinement an author added. The result is a valid native schema and is
compiled as written.

### Every field holds JSON

A schema can be structural about what it admits: `Type.Any()` admits a
`Date`, `undefined`, `NaN`, a class instance, and a cycle. None of those
survives being stored. So a compiled field asks whether a value is JSON before
its schema runs, for every field, in `check`, `issues`, `conformance`, and
`inputIssues`. A value that is not JSON fails with `must be a JSON value`, and
the schema's validator is not called. That order matters for a recursive
schema (`Type.Cyclic`), which follows a cyclic value until the stack overflows.

This is a property of the compiled field, not of the schema. A helper schema
checked directly with TypeBox's `Compile` admits what its keywords admit.

Being JSON has no size: `isJsonSafe` sets no depth or width limit, and a value
reachable by two paths is fine. The 16-level, 1024-key budget is `isJsonValue`
and `isJsonObject`, which the storages that want it apply themselves. A value
that is JSON and fails its schema gets TypeBox's own errors, at their own
paths. If a native refinement or recursive validator throws, that field
fails its check and reports `schema validation threw`. Valid sibling fields
stay readable. A refinement that throws on the eager null probe still fails
at the declaration.

### Who owns a declared schema

A helper copies its arguments: changing an options object, an option list, or
a wrapped schema after the call changes nothing, and nothing the caller passed
in is frozen. A schema the caller froze is copied the same way, hint replaced
and hidden refinements kept: `field.json(Object.freeze(field.select([...])))`
works, and so does declaring a frozen schema.

Helpers return native schema objects. Copies retain the input's property
descriptors, including read-only properties. An author who edits a schema before compilation
owns that edit, and the editor follows the schema: push a value onto a
select's `enum` and both the check and the options include it.

`compileData` takes ownership. For each field it takes one snapshot with
TypeBox's own clone, freezes the snapshot's plain objects and arrays, and
compiles that. `defineStore` and `defineFolder` compile at the declaration.
A field's name is its key in the compiled field map. Each field is a `DataField`:
`check` and `issues`, the frozen `schema` they were compiled from, and the
`editor` resolved from that same object.
Editing the declared schema afterwards changes none of them.

The snapshot holds own string-keyed data properties, hidden ones included,
which is every native constraint. Functions and TypeBox guard objects are
copied by reference and left unfrozen. Symbol keys, accessors, class
instances, and whatever a refinement callback closes over are not covered.

A field that is not a plain schema object, and a schema TypeBox cannot
compile, are refused with the table and field named. A string or a number in a
field map is also a type error. Nullability is asked of
the compiled field at the declaration, so a refinement that throws when given
`null` is refused there too.

### References

`field.reference(table)` is a nonempty string with a hint that names a table.
The target is editor intent, and it must be a usable table name (`isTableName`):
the helper throws on any other string, and a hand-written hint with one gets
the JSON editor. No storage checks that the table or the row exists, and no
storage rewrites a reference when a row is renamed or deleted. A stored
identifier may dangle.

## Field conformance

A compiled table checks each declared field by itself through read and write
methods:

```ts
const table = compileData(definition).data.tables.get('todos');

table.conformance(stored);                        // { conforming, issues }
table.inputIssues(supplied, { complete: true });  // issues with values to write
```

`conformance` returns the declared fields that validated beside the issues of
the ones that did not: a field that fails does not take a valid one with it,
and a key the table does not declare is neither. `inputIssues` checks values a
caller supplies for a write: an undeclared key, a value that does not conform,
and, for a complete row, a declared field that is absent.

An issue is `{ field, path?, message }`. `field.check(value)` decides whether a
value conforms, and `field.issues(value)` reports its diagnostics. Table methods
use those same issues, so the two agree
for nullable values, a reference's nonempty value, and a value that is not
JSON. `path` is a JSON pointer inside the field's value, such as `/1` for the
second item of a list. It is present only when the validator named a location
that can be walked in the value; TypeBox joins object keys into its path
unescaped, so a path through a key containing `/` or `~` is reported against
the whole field. TypeBox's own error types are not exported. Messages and the
number of issues are for people, not for code to match on.

## The body conversion

A table may declare how its separately edited body becomes file text. What a
body is belongs to the storage that keeps one, so this package types the
conversion as opaque (`TableBody`) and takes the storage's own type as a
parameter:

```ts
import type { DataDefinition, DefineTable } from '@epicenter/definition';

type MyDefinition = DataDefinition<MyBodyCodec>;
const defineMyTable: DefineTable<MyBodyCodec> = defineTable;
```

`compileData` checks that a declared conversion has both verbs and carries it
through unread. A storage that keeps no live body refuses a definition that
declares one.

## Commands

```sh
bun test          # field helpers, name grammars, compiler
bun run typecheck
```
