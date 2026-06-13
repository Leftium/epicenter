# Workspace Schema Definition Patterns

Detailed guidance for `defineTable`, `defineKv`, row type inference, scalar KV design, and branded table IDs.

## Tables

Before you define a table, decide whether the data belongs in the synced workspace at all. A single-writer, device-scoped log (a chat transcript, a per-device approval) is usually cheaper and more honest on the device than in a synced row, where it pays tombstone and sync costs for a conflict it never has. See [Not Everything Belongs in the Synced Workspace](../../../../docs/articles/20260612T210000-not-everything-belongs-in-the-synced-workspace.md).

Tables are built from TypeBox column schemas. Use the `field.*` builders from `@epicenter/field` for the SQLite-safe constructor menu (with the standalone `nullable` wrapper from `@epicenter/workspace` for the emptiness axis); raw `Type.X()` from `typebox` is interchangeable. The `FlatJsonTSchema` constraint enforces "one column maps 1:1 to a SQLite column" regardless of which side built the schema.

`_v` is library-managed end-to-end. Never declare it as a column key (it's a compile error), never set it on a write, never read it off a row. The library stamps it on every stored row, routes by it on read, and strips it before handing the row back.

### Shorthand (Single Version)

Use when a table has only one version. There is no migrate step:

```typescript
import { field } from '@epicenter/field';
import {
  defineTable,
  nullable,
  type InferTableRow,
} from '@epicenter/workspace';

const notesTable = defineTable({
  id: field.string<NoteId>(),
  title: field.string({ minLength: 1, maxLength: 200 }),
  body: nullable(field.string()),
  createdAt: field.datetime(),
});
export type Note = InferTableRow<typeof notesTable>;
```

### Variadic (Multiple Versions)

Use when you need to evolve a schema over time. Each positional argument is a version (v1 first, v2 second, etc.). The `.migrate()` step is required before the definition is usable: passing the intermediate builder to `createWorkspace`'s `tables` is a compile error.

```typescript
const notesTable = defineTable(
  // v1
  {
    id: field.string<NoteId>(),
    title: field.string(),
  },
  // v2
  {
    id: field.string<NoteId>(),
    title: field.string(),
    pinned: field.boolean(),
  },
).migrate(({ value, version }) => {
  switch (version) {
    case 1:
      return { ...value, pinned: false };
    case 2:
      return value;
  }
});
export type Note = InferTableRow<typeof notesTable>;
```

The migrate function receives a discriminated `{ value, version }` so `switch (version)` narrows `value` to the matching version's columns. The return type is the latest version's row. The user's columns are visible end-to-end; `_v` is invisible.

### Row Type Inference

**Always derive row types with `InferTableRow<typeof X>` against the table definition.** Export the type from the same file that calls `defineTable()`. Consumers `import type` it directly: never re-derive.

```typescript
// Good: schema is the single source of truth
const notesTable = defineTable(/* ... */);
export type Note = InferTableRow<typeof notesTable>;
```

```typescript
// Bad: goes through the runtime Table instance
type Note = ReturnType<typeof workspace.tables.notes.scan>['rows'][number];

// Bad: same smell, plucking the row type out of a point read
type Note = NonNullable<ReturnType<typeof workspace.tables.notes.get>['data']>;
```

Why `InferTableRow` is better:
- Source of truth is the schema, not a method signature.
- Doesn't require importing/building the runtime client (works in workers, server code, isomorphic modules).
- Survives method renames and signature changes.
- Matches the convention used across every app in this repo.

**Don't relay types through state files.** Reactive state files (e.g. `*.svelte.ts`) should `import type` from the workspace definition module, not redefine or re-export the row type. Other consumers should also import the type directly from the workspace module: not from the state file. State files export runtime values; the workspace module exports types.

```typescript
// state/notes.svelte.ts
import type { Note } from '$lib/workspace';     // Good: import directly
// export type { Note };                         // Bad: pass-through re-export

// some-component.svelte
import { notes } from '$lib/state/notes.svelte';  // runtime
import type { Note } from '$lib/workspace';       // type: same source as state file
```

## Store Facts, Not Liveness

A synced row stores facts: values that are true once and stay true. Never give a row a field whose only meaning is "a process is working on this right now." The process doing the work already knows it is alive. The moment it dies the stored claim becomes a lie no reader can detect, and the row wedges in the live state with no honest way to repair it. The fix every "status got stuck" bug reaches for, a startup scan that resets stale `running` rows, is code to undo a write you should never have made.

Model the durable outcome as a nullable terminal union, and let absence cover "not yet, or interrupted":

```typescript
import { Type } from 'typebox';
import { field } from '@epicenter/field';
import { defineTable, nullable } from '@epicenter/workspace';

// Terminal facts only. No `transcribing`/`running` variant.
const TranscriptionOutcome = Type.Union([
  Type.Object({ status: Type.Literal('completed'), completedAt: Type.String() }),
  Type.Object({ status: Type.Literal('failed'), completedAt: Type.String(), error: Type.String() }),
]);

const recordingsTable = defineTable({
  id: field.string<RecordingId>(),
  transcript: field.string(),                                 // the output, its own column
  transcription: nullable(field.json(TranscriptionOutcome)),  // null = not yet, or interrupted
});
```

Read liveness from where it actually lives. When the reader is the writer, read it off the in-flight operation: a recording is transcribing exactly while its TanStack mutation is pending. When the reader is a different tab or device, derive it from recency over a timestamp the row already carries, so a run with a recent `startedAt` and no result reads as live and a stale one reads as interrupted. Either way there is no stored flag and nothing to reset on startup.

Full rationale, including the multi-writer case and the timestamp heartbeat for long work, is in [Liveness Belongs to the Process, Not the Row](../../../../docs/articles/20260612T190745-liveness-belongs-to-the-process-not-the-row.md).

## KV Stores

KV stores use `defineKv(schema, defaultValue)`. No versioning, no migration: invalid stored data returns `defaultValue()` instead.

`defaultValue` is always a **factory function**, not a bare value. The library calls it on every default firing so each call returns a fresh, mutation-safe value.

```typescript
import { field } from '@epicenter/field';
import { defineKv } from '@epicenter/workspace';
import { Type } from 'typebox';

const sidebar = defineKv(
  Type.Object({ collapsed: Type.Boolean(), width: Type.Number() }),
  () => ({ collapsed: false, width: 300 }),
);
const fontSize = defineKv(field.number(), () => 14);
const enabled = defineKv(field.boolean(), () => true);
```

KV accepts any TypeBox `TSchema`: the `field.*` builders, raw `Type.X()`, or composed unions. There is no `FlatJsonTSchema` constraint on KV values (no SQLite materialization layer for KV).

### KV Design Convention: One Scalar Per Key

Use dot-namespaced keys for logical groupings of scalar values:

```typescript
// Good: each preference is an independent scalar
'theme.mode': defineKv(
  field.select(['light', 'dark', 'system']),
  () => 'light' as const,
),
'theme.fontSize': defineKv(field.number(), () => 14),

// Bad: structured object invites migration needs
'theme': defineKv(
  Type.Object({
    mode: field.select(['light', 'dark']),
    fontSize: Type.Number(),
  }),
  () => ({ mode: 'light' as const, fontSize: 14 }),
),
```

With scalar values, schema changes either don't break validation (widening `'light' | 'dark'` to `'light' | 'dark' | 'system'` still validates old data) or the default fallback is acceptable (resetting a toggle takes one click).

Exception: discriminated unions and `Record<string, T> | null` are acceptable when they represent a single atomic value.

## Branded Table IDs (Required)

Every table's `id` field and every string foreign key field MUST use a branded type instead of a plain `string`. This prevents accidental mixing of IDs from different tables at compile time.

### Pattern

Define a branded type as a **pure type alias** and a co-located `generate*` factory. There is no runtime validator object: the brand is type-only, and `field.string<NoteId>()` carries the brand through the schema.

```typescript
import type { Brand } from 'wellcrafted/brand';
import { field } from '@epicenter/field';
import {
  defineTable,
  generateId,
  nullable,
  type InferTableRow,
} from '@epicenter/workspace';

// 1. Branded type alias (co-located with workspace definition)
export type ConversationId = string & Brand<'ConversationId'>;

// 2. Generator function: the ONLY place with the cast
export const generateConversationId = (): ConversationId =>
  generateId<ConversationId>();

// 3. Use the brand inside field.string<>() to propagate it through the schema
const conversationsTable = defineTable({
  id: field.string<ConversationId>(),              // Primary key: branded
  title: field.string(),
  parentId: nullable(field.string<ConversationId>()),  // Self-FK
});
export type Conversation = InferTableRow<typeof conversationsTable>;

// 4. At call sites: use the generator, never cast directly
const newId = generateConversationId();  // Good
// const newId = 'abc' as ConversationId;  // Bad
```

`field.string<T>()` accepts a brand-extended string type as its sole generic. Passing a non-branded literal subtype (e.g. `field.string<'draft'>()`) is a compile error: literal-subtype pretending isn't enforced at runtime, so the type system refuses it. Use `field.select(['draft'])` for that case instead.

### `as*` Helper Variant for External-Source IDs

When the branded ID is not minted but received as a typed `string` from another typed source (Better Auth user id, URL param, DB column), pair the type with an `as*` syntactic-sugar helper instead of a `generate*` factory:

```typescript
export type UserId = string & Brand<'UserId'>;

/**
 * Syntactic sugar for `value as UserId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place `as UserId` should appear.
 */
export const asUserId = (value: string): UserId => value as UserId;
```

Pick the variant by ID origin:

| Origin of the value                         | Third part                                       |
| ------------------------------------------- | ------------------------------------------------ |
| Minted fresh by this code                   | `generateXxx()` factory (workspace table IDs)    |
| Received as a typed string                  | `asXxx(value: string)` syntactic-sugar helper    |
| Received as `unknown` at a network boundary | Validate with the action's TypeBox input schema  |

Type aliases are PascalCase; functions are camelCase. Schema bodies read `field.string<ConversationId>()` / `field.string<UserId>()` with no `Schema` suffix anywhere.
