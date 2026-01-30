# Implicit IDs Eliminate Boilerplate and Unify Field Types

**TL;DR**: When **every table needs an ID and nobody customizes the name**, making it implicit removes repetitive `id()` calls and collapses two field types into one.

> If 100% of usage follows a pattern, encode the pattern in the system.

## The Before State

Every table definition starts identically:

```typescript
table('posts', { fields: [id(), text('title')] });
table('users', { fields: [id(), text('name')] });
table('comments', { fields: [id(), text('body')] });
```

That `id()` is pure boilerplate. Searching the codebase: 200+ usages, zero cases of `id('customName')`.

Meanwhile, two separate types exist:

```typescript
type Field = IdField | TextField | SelectField | ...
type KvField = Exclude<Field, IdField>
```

`KvField` exists solely because KV stores don't have row IDs; they use the field's own `id` property as the key. But this distinction only matters because `IdField` is in the union.

## The After State

```typescript
// ID is implicit
table('posts', { fields: [text('title')] });
table('users', { fields: [text('name')] });

// Row type automatically includes id
type PostRow = { id: string; title: string };
```

The field union simplifies:

```typescript
type Field = TextField | SelectField | BooleanField | ...
type KvField = Field  // Same thing now
```

## Why This Works for CRDTs

Yjs and other CRDTs need stable, globally unique identifiers for merge semantics. Custom ID names don't help; the CRDT doesn't care what you call the field. It needs a synthetic ID to track the row across peers.

Composite keys complicate merging: what happens when both parts change simultaneously on different peers? Synthetic IDs sidestep this entirely.

If you need `[userId, postId]` uniqueness, use a unique constraint. The synthetic `id` remains the CRDT's identity; the constraint enforces your domain rules.

## What We Explicitly Don't Support

| Request                          | Response                             |
| -------------------------------- | ------------------------------------ |
| Custom ID name (`_id`, `postId`) | Handle at serialization boundary     |
| Composite primary keys           | Use synthetic ID + unique constraint |
| Tables without any ID            | Every table gets one; CRDTs need it  |

These aren't oversights. They're decisions that keep the core model simple. The serialization layer can reshape data for external systems; the schema layer models your domain with CRDT-friendly constraints.

## The Type-Level Enforcement

With implicit ID, 'id' becomes reserved. Trying to define `text({ id: 'id' })` fails at compile time:

```typescript
interface FieldError<T extends string> {
	__error: T;
}

type ValidFieldId<T extends string> = T extends 'id'
	? FieldError<'"id" is reserved - tables have implicit ID'>
	: T;
```

You see the error in your IDE before running anything.

## Migration

```bash
# The entire migration
find . -name "*.ts" -exec sed -i 's/id(), //g' {} \;
```

Remove `id()` from field arrays. That's it. Row types continue to include `id: string` because the table injects it.
