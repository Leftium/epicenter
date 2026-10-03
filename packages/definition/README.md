# @epicenter/definition

The declaration vocabulary every Epicenter storage reads: the field helpers,
table and KV declarations, the durable name grammars, the preparation that
checks a declaration and owns its schemas, and the reads over a prepared
definition.

It is inert. Importing it acquires nothing, and it knows no storage. Its only
dependencies are `typebox` and `wellcrafted`.

```ts
import {
  accepts,
  conformance,
  defineTable,
  field,
  prepareData,
} from '@epicenter/definition';
import { Type } from 'typebox';

const todos = defineTable({
  fields: {
    title: field.string(),
    due: field.nullable(field.instant()),
    estimate: Type.Object({ hours: Type.Number() }),
  },
});

const { data: definition } = prepareData({
  id: 'so.epicenter.todos',
  kv: { theme: field.select(['light', 'dark']) },
  tables: { todos },
});

accepts(definition.kv.theme, 'dark');                  // true
conformance(definition.tables.todos.fields, stored);   // { conforming, issues }
```

## One shape, declared and prepared

A definition is `{ id, title?, kv, tables }`. `kv` is a record of native
schemas by field name, and each table is `{ fields, body? }`, where `fields`
is the same kind of record. `prepareData` returns that same shape with the
same literal type, so `RowOf`, `KvOf`, and every field's `Static<>` read a
prepared definition exactly as they read the declaration. There is no second,
compiled representation: no field wrapper, no table object with methods, no
`Map`, and no name stored anywhere but the record key.

What preparation adds is ownership and a validator:

- It checks the id, the title, the table and field names, each body
  conversion, and that TypeBox can compile every schema.
- Each field becomes a frozen snapshot of the declared schema, `x-field` hint
  included. `kv`, `tables`, and each `fields` are frozen records with no
  prototype, so a table or field named `constructor` or `toString` is an
  ordinary entry and a name the definition lacks reads as `undefined`.
- TypeBox's compiled validator for each snapshot is held privately beside it.
  The three reads below look it up by the snapshot's identity.

`prepareData` is memoized on the declaration object and on the definition it
returns, so preparing a prepared definition returns it. `defineStore` and
`defineFolder` return the prepared definition, and the stores and folders
opened from it read through that snapshot.

The reads take a prepared field or a prepared field record:

| Read | What it answers |
| --- | --- |
| `accepts(schema, value)` | Whether one value is JSON and the field's check admits it. `undefined` in place of a schema, which is what a name the definition does not declare reads as, accepts nothing. |
| `conformance(fields, payload)` | A stored payload read through the fields: the ones that validated, and the issues of the ones that did not. |
| `inputIssues(fields, values, { complete })` | The issues of values supplied for a write: an undeclared key, a value that does not conform, and, for a complete row, an absent field. |

A schema that was never prepared has no validator. Handing one to any of the
three throws: it is a programmer error, not a value that failed. Nothing is
compiled lazily, and the answer is never a silent `false`.

## Who uses it

| Package | What it adds |
| --- | --- |
| `@epicenter/app` | `defineStore`, and a table body bound to a Yjs node (`BodyCodec`, `plainText()`). It re-exports this vocabulary from its root, `/field`, and `/definition`. |
| `@epicenter/folder` | `defineFolder`, which refuses a body conversion, because a folder's row body is the file's Markdown text. |

Both get the same `defineTable` brand, the same `RowOf`, `CreateRowOf`, and
`KvOf` lenses, and the same reads over the same prepared fields. Neither
copies a validator.

## Why this name

The package holds what App already exported as `@epicenter/app/definition` and
`@epicenter/app/field`: the things a `DataDefinition` is made of and the
function that prepares one. Its import closure is those modules and nothing
else:

```text
src/field/        the field.* helpers, the editor hint, and fieldEditorOf (./field)
src/declaration   FieldMap, TableDeclaration, DataDefinition, row lenses
src/define        defineTable and the declared-table brand
src/prepare       prepareData, accepts, conformance, inputIssues
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
wrong hint, or an unknown hint checks, reports issues, and conforms
identically.

`fieldEditorOf(schema)` reads the editor a schema asks for:

```ts
const { status } = definition.kv;

fieldEditorOf(status);
// { kind: 'select', options: ['draft', 'published'] }
accepts(status, null);
// true: this field is field.nullable(field.select([...]))
```

| Part | Where it comes from |
| --- | --- |
| `kind` | The hint, when the schema has that widget's shape. Otherwise `json`. |
| `options` | The schema's declared `enum` for a select, `items.enum` for a multi-select. |
| `target` | The hint, for a reference, when it is a usable table name. |

`options` is the declared list. The check never admits a value outside it,
but another keyword or a native refinement on the same schema can refuse one
of them, and nothing filters the list by running those.

`fieldEditorOf` reads keywords and nothing else. It keeps no state, runs no
validator, and calls no callback, so it works on any schema, prepared or not,
and it says nothing about `null`. Whether a field admits `null` is a question
for its check, asked where the answer is used: `accepts(schema, null)` on the
prepared field. It is not read off the keywords, because they do not decide
it. `Type.Any()` names no `null` and admits one. A refinement over a union
with `null` can refuse it, and one that throws on `null` does not admit it.
Preparing a definition validates no value, so it runs no callback to find
out.

A field gets the JSON editor when:

- it has no hint: a bare `Type.Enum` is not a select, and nothing is guessed;
- the hint's kind is unknown or the hint is malformed;
- a reference's target is not a usable table name;
- the schema does not have the shape the named widget edits: a `string` hint
  on a number, a `select` hint with no string `enum`, or a string `enum`
  beside a `type` that is not `string`;
- the schema declares a `format` other than the one the named widget writes:
  `Type.String({ format: 'email', 'x-field': { kind: 'date' } })`. The formats
  are `uri` for `url`, `date` for `date`, and `date-time` for `instant` and
  `datetime`. The same format, or no format, fits. `string` and `reference`
  name no format, so any format fits them;
- the schema, or the item schema of a list, is composed: it has `anyOf`,
  `allOf`, `oneOf`, `not`, `if`, `then`, `else`, or `$ref`.

These are conservative checks of a keyword or two on one schema node, not a
schema recognizer. They err toward the JSON editor, and none asks whether the
schema as a whole can be satisfied.

One composition is read through: a union of exactly `{ type: 'null' }` and one
other schema, with only annotations beside the `anyOf`. That is what
`field.nullable` builds, and the same union written with `Type.Union` reads
the same. When the union has no `x-field` of its own it takes its other
member's hint, so `field.nullable(field.select([...]))` is a select that also
admits `null`.
A union that has its own `x-field` uses that one, and an unusable one gets the
JSON editor; it is not replaced by the member's. A validation keyword beside
the `anyOf`, such as a root `type`, also decides what the field admits, so that
union is not read through.

The prepared snapshot is frozen, so an editor read from a prepared field
describes the schema its validator checks.

### What survives JSON

Helpers add portable keywords and editor hints, without introducing a
refinement callback or codec. A keyword-based schema read back through
`JSON.parse(JSON.stringify(schema))` prepares to the same checks, issues, and
editor. Constraints supplied as native callbacks remain local.

A native `Type.Refine` works wherever a schema is declared, including over a
helper (`Type.Refine(field.string(), ...)`), and runs locally. Its callback is
a function, so it is not in the schema's JSON form. The same holds for a
codec. A declaration that uses either cannot be serialized faithfully. A codec
is carried and never run: the reads call TypeBox's `Check` and `Errors`, which
do not decode or encode, so no value is transformed here.
This package has no exporter and no importer for other JSON Schema dialects.

A spread (`{ ...field.string() }`) keeps the enumerable keywords and drops any
hidden refinement an author added. The result is a valid native schema and is
prepared as written.

### Every field holds JSON

A schema can be structural about what it admits: `Type.Any()` admits a
`Date`, `undefined`, `NaN`, a class instance, and a cycle. None of those
survives being stored. So every read asks whether a value is JSON before the
field's schema runs, for every field, in `accepts`, `conformance`, and
`inputIssues`. A value that is not JSON fails with `must be a JSON value`, and
the schema's validator is not called. That order matters for a recursive
schema (`Type.Cyclic`), which follows a cyclic value until the stack overflows.

This is a property of the reads over a prepared field, not of the schema. A
helper schema checked directly with TypeBox's `Compile` admits what its
keywords admit.

Being JSON has no size: `isJsonSafe` sets no depth or width limit, and a value
reachable by two paths is fine. The 16-level, 1024-key budget is `isJsonValue`
and `isJsonObject`, which the storages that want it apply themselves. A value
that is JSON and fails its schema gets TypeBox's own errors, at their own
paths. If a native refinement or recursive validator throws, that field
fails its check and reports `schema validation threw`. Valid sibling fields
stay readable.

### Validation only reads

No read changes the value it is given. TypeBox's keyword
validation is read-only by itself. A native callback is not: `Type.Refine` and a
`~guard` hand the value to the author's function, which could write to it. So a
field whose schema holds a function or a `~guard` validates a private, deeply
frozen copy of the value, and the caller's value is neither written nor
frozen:

```ts
const meta = Type.Refine(Type.Object({ touched: Type.Optional(Type.Boolean()) }), (value) => {
  value.touched = true; // refused: the argument is frozen
  return true;
});
```

A refused write throws in strict code, which is every module. The field then
fails with `schema validation threw`, like any other throwing callback. A
conforming value in `conformance` is always the caller's own object.

The copy holds arrays and plain objects: each object's prototype (plain or
null), its own enumerable keys including one named `__proto__`, and shared
nodes, which stay shared. It is made without recursion, so depth has no limit.
A cycle, or a class instance that is not an array, is refused as not JSON
before any callback runs. An array subclass passes `Array.isArray`, as it does
in `isJsonSafe`, and its copy is a plain array. A schema of keywords alone,
which is every unrefined helper, makes no copy.

The supported values are stored JSON content: array elements and own
enumerable string-keyed data properties. A non-enumerable, accessor, or
inherited property is outside that, and the two kinds of field read it
differently. A keyword-only schema reads the caller's value, so
`Type.Object({ hidden: Type.Number() })` admits an object whose `hidden` is
non-enumerable. The same schema under `Type.Refine` reads the copy, which has
no `hidden`, and refuses it. This is a limit of the copy, stated and not
enforced: nothing rejects or normalizes such a value.

This protects the argument a callback is given, and nothing else. A callback
is a deterministic predicate over content. Preparation calls none. A read may
invoke them more than once, and asking `accepts(schema, null)` invokes them
with `null`; timing and call count are not guaranteed. State it closes over, state a guard
object keeps, side effects, and answers that change between calls are the
author's to get right. A callback sees a copy, so one that compares object
identity is asking something a stored JSON value cannot answer. It is not a
sandbox.

### Who owns a declared schema

A helper copies its arguments: changing an options object, an option list, or
a wrapped schema after the call changes nothing, and nothing the caller passed
in is frozen. A schema the caller froze is copied the same way, hint replaced
and hidden refinements kept: `field.json(Object.freeze(field.select([...])))`
works, and so does declaring a frozen schema.

Helpers return native schema objects. Copies retain the input's property
descriptors, including read-only properties. An author who edits a schema before preparation
owns that edit, and the editor follows the schema: push a value onto a
select's `enum` and both the check and the options include it.

`prepareData` takes ownership. For each field it takes one snapshot with
TypeBox's own clone, freezes the snapshot's plain objects and arrays, compiles
a validator for it, and puts the snapshot in the definition it returns.
`defineStore` and `defineFolder` prepare at the declaration and return that
definition. A field's name is its key in `kv` or in its table's `fields`.
Editing the declared schema afterwards changes nothing a prepared definition
reads, with the exception below.

A validator belongs to a snapshot, never to the author's schema. Every field
of every preparation gets its own snapshot, so one declared schema used in two
definitions, or under two names, is prepared twice: edit it between two
`defineStore` calls and the first store keeps the checks it was defined with
while the second reads the edit. The author's own schema object is not a
prepared field, and the reads refuse it.

The snapshot holds own string-keyed data properties, hidden ones included,
which is every native constraint. A function is kept by reference and left
unfrozen. So is any node with a `~guard` key, whole: TypeBox's clone returns
that node itself, with the guard and every keyword beside it, whether it is the
field's root or nested. That node is still the author's object, it is not
frozen, and an edit to it after preparation is not held off. A field whose
root has a `~guard` is therefore the author's own object in the prepared
definition too, and it reads through the validator of the latest definition
that prepared it. Symbol keys, accessors, class instances, and whatever a
callback or guard closes over are not covered either.

A body conversion is carried by reference, unread and unfrozen.

A field that is not a plain schema object, and a schema TypeBox cannot
compile, are refused with the table and field named. A string or a number in a
field map is also a type error. Whether a field admits `null` is not such a
gate: a refinement that throws when given `null` is prepared like any other,
and a stored `null` fails where it is read.

### References

`field.reference(table)` is a nonempty string with a hint that names a table.
The target is editor intent, and it must be a usable table name (`isTableName`):
the helper throws on any other string, and a hand-written hint with one gets
the JSON editor. No storage checks that the table or the row exists, and no
storage rewrites a reference when a row is renamed or deleted. A stored
identifier may dangle.

## Field conformance

A table's prepared fields check each declared field by itself, for a read and
for a write:

```ts
const { fields } = definition.tables.todos;

conformance(fields, stored);                        // { conforming, issues }
inputIssues(fields, supplied, { complete: true });  // issues with values to write
```

`conformance` returns the declared fields that validated beside the issues of
the ones that did not: a field that fails does not take a valid one with it,
and a key the table does not declare is neither. Every declared field must be
present. `inputIssues` checks values a caller supplies for a write: an
undeclared key, a value that does not conform, and, for a complete row, a
declared field that is absent. A key supplied as `undefined` is a value that
is not JSON, which is a different issue from a key that is absent.

Which of these a storage runs on a write is that storage's rule. App checks
names and that a value is JSON when it writes, and reads through
`conformance`. Folder checks supplied values with `inputIssues` before it
writes a file.

An issue is `{ field, path?, message }`. One private diagnostic over a field's
validator feeds both, so `conformance` and `inputIssues` report a failing
value the same way, and both report nothing exactly when `accepts` says yes.
So they agree for nullable values, a reference's nonempty value, and a value
that is not JSON. There is no public per-field diagnostics function and no
second table of validators. TypeBox's compiled `Check` is the
authority: a value it refuses is an issue even when its error report is empty.
`path` is a JSON pointer inside the field's value, such as `/1` for the
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

`prepareData` checks that a declared conversion has both verbs and carries it
through unread, by reference, on the prepared table. It returns the type it
was given, so a storage's own body type survives preparation with no adapter.
A storage that keeps no live body refuses a definition that declares one.

## Commands

```sh
bun test          # field helpers, name grammars, preparation and reads
bun run typecheck
```
