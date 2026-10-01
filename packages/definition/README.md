# @epicenter/definition

The declaration vocabulary every Epicenter storage reads: the closed field
palette, table and KV declarations, the durable name grammars, and the compiler
that turns a declaration into field checks.

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
src/field/        closed field kinds, builders, and recognition (./field)
src/declaration   FieldMap, TableDeclaration, DataDefinition, field.nullable, row lenses
src/define        defineTable and the declared-table brand
src/compile       compileData, ParsedTable, conformance
src/addresses     data ID, table name, and row ID grammars
src/json          JsonValue and its guards
```

There is no store, schema migration, or query code here, so `definition` says
what it is more exactly than `schema`, `data`, or `core` would.

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
bun test          # field palette, name grammars, compiler
bun run typecheck
```
