# @epicenter/definition

The declaration vocabulary every Epicenter storage reads: the field helpers,
table and KV declarations, the durable name grammars, and the compiler that
turns a declaration into field checks.

It is inert. Importing it acquires nothing, and it knows no storage. Its only
dependencies are `typebox` and `wellcrafted`.

```ts
import { compileData, defineTable, field } from '@epicenter/definition';

const todos = defineTable({
  fields: { title: field.string(), due: field.nullable(field.instant()) },
});
```

## Who uses it

| Package | What it adds |
| --- | --- |
| `@epicenter/app` | `defineStore`, and a table body bound to a Yjs node (`BodyCodec`, `plainText()`). It re-exports this vocabulary from its root, `/field`, and `/definition`. |
| `@epicenter/folder` | `defineFolder`, which refuses a body conversion and reference fields, because a folder's row body is the file's Markdown text. |

Both get the same `defineTable` brand, the same `RowOf`, `CreateRowOf`, and
`KvOf` lenses, and the same compiled field checks. Neither copies a validator.

## Why this name

The package holds what App already exported as `@epicenter/app/definition` and
`@epicenter/app/field`: the things a `DataDefinition` is made of and the
function that compiles one. Its import closure is those modules and nothing
else:

```text
src/field/        the field.* helpers and the annotation they attach (./field)
src/declaration   FieldMap, TableDeclaration, DataDefinition, DataField, row lenses
src/define        defineTable and the declared-table brand
src/compile       compileData, ParsedTable, conformance
src/addresses     data ID, table name, and row ID grammars
src/json          JsonValue and its guards
```

There is no store, schema migration, or query code here, so `definition` says
what it is more exactly than `schema`, `data`, or `core` would.

## A field is one native schema

Every `field.*` helper returns a native TypeBox schema. `Static<>` reads it,
and TypeBox's `Compile` is the only thing that decides whether a value
conforms. The helper also sets one enumerable keyword on that schema,
`x-field`, which says which editor the field gets:

```ts
field.select(['draft', 'published'])['x-field'];
// { kind: 'select', nullable: false, options: ['draft', 'published'] }

field.nullable(field.reference('pages'))['x-field'];
// { kind: 'reference', nullable: true, target: 'pages' }
```

The schema and the annotation come from the same arguments in the same call.
Nothing inspects a schema's keywords to work out a kind, and nothing rebuilds a
schema from its JSON form.

| Helper | Native schema | Kind |
| --- | --- | --- |
| `string`, `reference(table)` | `Type.String`; a reference is never empty | `string`, `reference` |
| `url`, `date`, `instant`, `datetime` | `Type.String` with a format | the helper's name |
| `number`, `integer`, `boolean` | `Type.Number`, `Type.Integer`, `Type.Boolean` | the helper's name |
| `select(options)`, `multiSelect(options)` | `Type.Enum`, `Type.Array(Type.Enum)` | `select`, `multiSelect` |
| `tags` | `Type.Array(Type.String())` | `tags` |
| `json(schema)` | `{ if: <is JSON>, then: schema, else: <refuse> }` | `json` |
| `nullable(field)` | `Type.Union([field, Type.Null()])` | the field's kind, `nullable: true` |

A field map takes helper-built fields only. A bare `Type.String()` is a type
error in `defineTable` and in `kv`, and `compileData` refuses it. Native
`Type.*` schemas go inside `field.json`, which wraps the schema it is given
without rebuilding it, so its refinements still run:

```ts
field.json(Type.Array(Type.Object({ entryId: Type.String() })));
field.json(field.select(['small', 'large'])); // the select's check, a JSON editor
```

A `json` field holds JSON whatever its schema admits: a `Date`, `undefined`,
`NaN`, a class instance, and a cycle are refused. The conditional decides that
before the payload schema runs, in `Check` and in `Errors`, so a recursive
schema (`Type.Cyclic`) never follows a cyclic value. Being JSON has no size:
`isJsonSafe` sets no depth or width limit. The 16-level, 1024-key budget is
`isJsonValue` and `isJsonObject`, which the storages that want it apply
themselves. When the payload schema refuses a value, TypeBox reports one
`must match "then" schema` instead of the schema's own errors.

`field.string({ maxBytes })` is a native `Type.Refine`.

Helpers take the options their types list (`title` and `description`
everywhere; length, range, and list bounds where they apply) and throw on any
other key, so an option cannot replace a `type`, a `format`, or the annotation.
A `default` is not an option: defaults belong to the application.

The annotation's type is what the helper was told. A widget reads
`field.select(['draft', 'published'])['x-field'].options` as
`readonly ['draft', 'published']`, and `nullable` as `true` or `false`.

### Who owns a declared schema

A helper copies its arguments: changing an options object, an option list, or
a `field.json` payload schema after the call changes nothing, and nothing the
caller passed in is frozen. What the helper returns is an ordinary native
schema, as mutable as any `Type.*` result. Only the annotation object and its
option list are frozen.

`compileData` takes ownership. For each field it takes one snapshot with
TypeBox's own clone, freezes the snapshot's plain objects and arrays, and
compiles that. `defineStore` and `defineFolder` compile at the declaration.
Each compiled field is a `DataField`: `check` and `errors` from TypeBox, plus
the frozen `schema` they were compiled from and the `metadata` read off that
same object. Editing the declared schema afterwards changes none of them, so
`check` and `errors` agree with each other and with what a widget shows.

The snapshot holds own string-keyed data properties, hidden ones included,
which is every native constraint. Functions and TypeBox guard objects are
copied by reference and left unfrozen. Symbol keys, accessors, class
instances, and whatever a refinement callback closes over are not covered.

### What a helper built, and what an author changed

A helper also leaves a hidden `~field` mark, not enumerable, like TypeBox's
`~kind` and `~refine`. `compileData` requires it. TypeBox's clone and
`Type.Refine(field.string(), ...)` carry it, so those compile. A spread
(`{ ...field.string({ maxBytes: 4 }) }`), `Type.Unsafe(field)`, or a
hand-written `x-field` does not carry it, and is refused: each of those also
drops hidden constraints such as the byte ceiling, and would otherwise compile
without them.

The mark says a helper built the schema. It does not say nobody edited it
since. An author who changes a helper's schema natively before it is compiled,
or wraps it in something that keeps the mark, owns that change; the compiler
does not re-derive a kind from the keywords to check it.

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
