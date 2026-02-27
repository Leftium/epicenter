# Tagged Error Minimal Design: First Principles Redesign

**Created**: 2026-02-26
**Status**: Draft — open questions remain
**Scope**: wellcrafted `TaggedError` type, `createTaggedError` builder API
**Related**: `20260226T000000-granular-error-migration.md` (service-by-service migration, depends on this)

## Summary

A critical examination of `TaggedError`'s shape, stripped to first principles. The current design has four fields: `name`, `message`, `context`, `cause`. This spec argues for two non-negotiable fields (`name`, `message`) with additional properties spread flat on the error object rather than nested under `context`.

---

## The Console Log Test

The design principle: imagine every error in the app hits one logging function. What do you actually want to see?

```
[RecorderBusyError] A recording is already in progress

[ResponseError] HTTP 401
  provider: openai
  status: 401
  model: gpt-4o

[DbQueryError] Database insert on recordings failed
  table: recordings
  operation: insert
  backend: indexeddb
```

Three completely different shapes. The only universal fields are **name** and **message**. Everything else is domain-specific.

---

## Decision: Non-Negotiable Fields

### `name` — The discriminant tag

```typescript
switch (error.name) {
  case 'ResponseError': ...
  case 'ConnectionError': ...
  case 'ParseError': ...
}
```

This is the entire reason the pattern exists. Machine-readable. Exhaustive matching. Type narrowing. No debate.

### `message` — Human-readable description

Every error needs a string to show or record. Logs, toast notifications, debugging — `message` is consumed everywhere. And critically, `message` is computed from the error's data via `.withMessage()`, which is the whole point of the builder: define the template once, every call site gets a consistent message.

### The minimum TaggedError

```typescript
type TaggedError<TName extends string> = Readonly<{
  name: TName;
  message: string;
}>;
```

This is already defined as `AnyTaggedError` in the current codebase (line 21 of `types.ts`). It's sufficient for discriminated unions, human-readable output, and serialization.

---

## Decision: Flat Spreading Over Nested `context`

### The current design (nested)

```typescript
type TaggedError<TName, TContext, TCause> = Readonly<
  { name: TName; message: string }
  & WithContext<TContext>  // → { context: TContext }
  & WithCause<TCause>     // → { cause: TCause }
>;
```

Access: `error.context.status`, `error.context.provider`

### The proposed design (flat)

```typescript
type TaggedError<TName extends string, TProps extends JsonObject = {}> = Readonly<
  { name: TName; message: string } & TProps
>;
```

Access: `error.status`, `error.provider`

### Why flat is better

**1. Ergonomics at consumption sites**

```typescript
// Nested (current) — awkward destructuring
case 'ResponseError': {
  const { context: { status }, message } = postError;
}

// Flat (proposed) — just works
case 'ResponseError': {
  const { status, message } = postError;
}
```

**2. Ergonomics in message templates**

```typescript
// Nested
.withMessage(({ context }) => `HTTP ${context.status}`)

// Flat
.withMessage(({ status }) => `HTTP ${status}`)
```

**3. Simpler mental model**

An error IS its properties. `{ name: 'ResponseError', message: 'HTTP 401', status: 401, provider: 'openai' }` reads as a single coherent object, not a wrapper around some inner data bag.

### The namespace collision argument (and why it's solvable)

The main counter-argument: "what if a context field is named `name` or `message`?" This is trivially prevented at the type level:

```typescript
type ReservedKeys = 'name' | 'message';

type ValidProps<T extends Record<string, JsonValue>> =
  keyof T & ReservedKeys extends never ? T : never;
```

TypeScript would reject `.withProps<{ name: string }>()` at compile time. The builder API already enforces types — adding one more constraint is trivial.

### The structured logging argument (and why it's minor)

Nested context is slightly easier to scan in JSON logs:

```json
// Flat — all fields mixed
{ "name": "ResponseError", "message": "HTTP 401", "status": 401, "provider": "openai" }

// Nested — grouped
{ "name": "ResponseError", "message": "HTTP 401", "context": { "status": 401, "provider": "openai" } }
```

But this is a readability preference, not a structural problem. And the grouping is trivially reconstructible:

```typescript
const { name, message, ...rest } = error;
// rest = { status: 401, provider: 'openai' }
```

### The generic operations argument (and why it's fine)

"How do you write a function that takes any tagged error and accesses just the extra fields?"

```typescript
// Nested: error.context
// Flat: const { name, message, ...context } = error;
```

One extra line. And in practice, generic error handling rarely needs to iterate over context fields — it uses `name` for routing and `message` for display. The specific typed fields are only accessed after narrowing, where the flat form is better.

---

## Decision: `cause` Is Not a First-Class Field

### How `cause` is used today

| Claim | Reality |
|---|---|
| Preserves original error for debugging | `extractErrorMessage(error)` destroys it everywhere — the original error object is gone |
| Sentry uses it for stack grouping | No Sentry integration exists. If it did, JavaScript's native `Error.cause` (ES2022) is the standard |
| Error chain traversal | No code in the codebase walks a cause chain |

### The honest assessment

```
┌──────────┬─────────────────────────┬──────────────────────────────────┐
│ Field    │ Consumer                │ Reality                         │
├──────────┼─────────────────────────┼──────────────────────────────────┤
│ name     │ Code (switch/match)     │ Essential. No debate.           │
│          │ Logs (filtering)        │                                 │
├──────────┼─────────────────────────┼──────────────────────────────────┤
│ message  │ User (toast)            │ Essential. No debate.           │
│          │ Logs (human-readable)   │                                 │
├──────────┼─────────────────────────┼──────────────────────────────────┤
│ context  │ Code (structured data)  │ Useful but varies wildly.       │
│          │ Logs (searchable fields)│ → Spread flat, not nested.      │
├──────────┼─────────────────────────┼──────────────────────────────────┤
│ cause    │ Developers (debugging)  │ Currently destroyed everywhere. │
│          │ Sentry (grouping)       │ Nobody uses it today.           │
└──────────┴─────────────────────────┴──────────────────────────────────┘
```

`cause` as a top-level field on `TaggedError` is ceremony nobody uses. If a specific error type wants to carry the original error, it's just another typed field:

```typescript
const { BackendError, BackendErr } = createTaggedError('BackendError')
  .withProps<{ backend: string; cause: string }>()
  .withMessage(({ backend }) => `${backend} failed`);
```

No special type machinery. No `WithCause<TCause>` conditional type. No `.withCause()` builder step. Just a field, like any other.

---

## Proposed Type Design

### The TaggedError type

```typescript
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = Record<string, JsonValue>;

// Prevent collision with reserved error fields
type ReservedKeys = 'name' | 'message';
type ValidProps<T extends JsonObject> =
  keyof T & ReservedKeys extends never ? T : never;

// The error type — two required fields, additional props spread flat
type TaggedError<
  TName extends string = string,
  TProps extends JsonObject = Record<never, never>,
> = Readonly<{ name: TName; message: string } & TProps>;

// Minimum constraint for "any tagged error"
type AnyTaggedError = { name: string; message: string };
```

### What the builder produces

```typescript
// No extra props — just name + message
const { FsServiceError, FsServiceErr } = createTaggedError('FsServiceError')
  .withMessage(() => 'File system operation failed');
// Shape: { name: 'FsServiceError', message: string }

// With props — spread flat on the error
const { ResponseError, ResponseErr } = createTaggedError('ResponseError')
  .withProps<{ status: number; reason?: string }>()
  .withMessage(({ status }) => `HTTP ${status}`);
// Shape: { name: 'ResponseError', message: string, status: number, reason?: string }

// "Cause" is just another field if you want it
const { BackendError, BackendErr } = createTaggedError('BackendError')
  .withProps<{ backend: string; cause: string }>()
  .withMessage(({ backend }) => `${backend} failed`);
// Shape: { name: 'BackendError', message: string, backend: string, cause: string }
```

### How the builder changes

```
Current chain:     createTaggedError('XError').withContext<C>().withCause<E>().withMessage(fn)
Proposed chain:    createTaggedError('XError').withProps<P>().withMessage(fn)
```

- `.withContext()` → renamed (see open questions below)
- `.withCause()` → removed as a builder step
- `.withMessage()` — still the required terminal step, but the message function receives `{ name } & TProps` instead of `{ name, context?, cause? }`

### Call site input changes

```typescript
// Current — nested under `context`
ResponseErr({ context: { status: 404 } })

// Proposed — flat
ResponseErr({ status: 404 })
```

The factory function's input is just `TProps` (or optional when `TProps` is empty):

```typescript
// When TProps = Record<never, never>: no argument needed
FsServiceErr()

// When TProps has required fields: argument required
ResponseErr({ status: 404 })

// When all TProps fields are optional: argument optional
SomeErr()  // or SomeErr({ reason: 'details' })
```

---

## Three Tiers of Error Complexity (Flat Design)

These tiers carry forward from the granular migration spec, adapted for flat props.

### Tier 1: Static errors — no props, no arguments

The error name + template IS the message. Use when there's no dynamic content.

```typescript
const { RecorderBusyError, RecorderBusyErr } = createTaggedError('RecorderBusyError')
  .withMessage(() => 'A recording is already in progress');

RecorderBusyErr()  // no argument needed
// → { name: 'RecorderBusyError', message: 'A recording is already in progress' }
```

### Tier 2: Reason-only — `reason` carries `extractErrorMessage(error)`

Use when the only dynamic content is the stringified caught error.

```typescript
const { PlaySoundError, PlaySoundErr } = createTaggedError('PlaySoundError')
  .withProps<{ reason: string }>()
  .withMessage(({ reason }) => `Failed to play sound: ${reason}`);

PlaySoundErr({ reason: extractErrorMessage(error) })
// → { name: 'PlaySoundError', message: 'Failed to play sound: device busy', reason: 'device busy' }
```

### Tier 3: Structured data — domain-specific fields

Use when there's data worth preserving as named fields that callers branch on.

```typescript
const { ResponseError, ResponseErr } = createTaggedError('ResponseError')
  .withProps<{ status: number; reason?: string }>()
  .withMessage(({ status, reason }) =>
    `HTTP ${status}${reason ? `: ${reason}` : ''}`
  );

ResponseErr({ status: 404 })
// → { name: 'ResponseError', message: 'HTTP 404', status: 404 }

ResponseErr({ status: 500, reason: 'Internal error' })
// → { name: 'ResponseError', message: 'HTTP 500: Internal error', status: 500, reason: 'Internal error' }
```

---

## Message Function Signature

The `.withMessage()` callback receives the error's props (without `name` and `message`, since `message` is what it's computing and `name` is always the literal string from `createTaggedError`).

```typescript
// Current signature (nested)
type MessageFn<TContext, TCause> = (input: {
  name: TName;
  context?: TContext;
  cause?: TCause;
}) => string;

// Proposed signature (flat)
type MessageFn<TProps extends JsonObject> = (input: TProps) => string;
```

Examples of what the message function receives:

```typescript
// Tier 1: no props → receives {}
.withMessage(() => 'Static message')

// Tier 2: { reason: string } → receives { reason: string }
.withMessage(({ reason }) => `Failed: ${reason}`)

// Tier 3: { status: number; provider: string } → receives { status, provider }
.withMessage(({ status, provider }) => `${provider}: HTTP ${status}`)
```

Note: `name` is NOT passed to the message function. It's redundant — the message function is already defined inside `createTaggedError('XError')`, so the name is known at definition time. If a message template truly needs the name (rare), it can close over it.

---

## Builder Implementation Sketch

The runtime implementation of `createTaggedError` changes minimally. The builder is already a closure that captures `name` and returns chain methods. The key differences:

### Current implementation (simplified)

```typescript
function createTaggedError<TName extends `${string}Error`>(name: TName) {
  function createBuilder<TContext, TCause>() {
    return {
      withContext: <C>() => createBuilder<C, TCause>(),
      withCause: <E>() => createBuilder<TContext, E>(),
      withMessage: (fn) => {
        const errorConstructor = (input = {}) => ({
          name,
          message: fn({ name, ...input }),
          ...('context' in input ? { context: input.context } : {}),
          ...('cause' in input ? { cause: input.cause } : {}),
        });
        // ... return { [name]: errorConstructor, [errName]: errConstructor }
      },
    };
  }
  return createBuilder();
}
```

### Proposed implementation (simplified)

```typescript
function createTaggedError<TName extends `${string}Error`>(name: TName) {
  function createBuilder<TProps extends JsonObject>() {
    return {
      withProps: <P extends ValidProps<P>>() => createBuilder<P>(),
      withMessage: (fn: (input: TProps) => string) => {
        const errorConstructor = (input?: TProps) => ({
          name,
          message: fn(input ?? {} as TProps),
          ...(input ?? {}),
        });
        const errName = name.replace(/Error$/, 'Err');
        const errConstructor = (input?: TProps) => Err(errorConstructor(input));
        return {
          [name]: errorConstructor,
          [errName]: errConstructor,
        };
      },
    };
  }
  return createBuilder<Record<never, never>>();
}
```

Key changes:
- **One type parameter** (`TProps`) instead of two (`TContext`, `TCause`)
- **No nesting** — `input` is spread directly onto the error object
- **No conditional context/cause handling** — just `...(input ?? {})`
- **`ValidProps` enforced** at the `.withProps()` call to prevent reserved key collisions

---

## The Mental Model

```
┌─────────────────────────────────────────────────────────┐
│ name     →  "What broke?" (for code / switch matching)  │
│ message  →  "What do I tell the user?" (for UI / logs)  │
│ ...rest  →  "What else matters?" (typed per error)      │
└─────────────────────────────────────────────────────────┘
```

- **Small services** (autostart, tray, sound): no extra props. `name` + `message` is the whole error.
- **API services** (completion, transcription): extra props carry `provider`, `status`, `retryable`.
- **CRUD services** (DB, recorder): extra props carry `operation`, `table`, `backend`.
- **`cause`**: If a specific error type wants it, it's `cause: string` as a regular prop. Not special.

---

## Open Questions

### 1. What should `.withContext()` be renamed to?

If extra fields are spread flat (not nested under `context`), the name `withContext` implies a namespace that doesn't exist. Options:

| Option | Example | Pros | Cons |
|---|---|---|---|
| `.withProps()` | `createTaggedError('X').withProps<{...}>()` | Generic, accurate | "Props" has React connotations |
| `.withFields()` | `createTaggedError('X').withFields<{...}>()` | Clear, no baggage | Slightly verbose |
| `.with()` | `createTaggedError('X').with<{...}>()` | Minimal | Maybe too terse, hard to search for |
| `.withContext()` | (keep current name) | No migration, familiar | Name implies nesting that doesn't exist |
| `.withData()` | `createTaggedError('X').withData<{...}>()` | Clear separation from metadata | "Data" is overloaded |

**Leaning toward**: `.withProps()` or `.withFields()`. Needs decision.

### 2. Should the input at call sites use a wrapper key or be fully flat?

Two options for how the factory is called:

```typescript
// Option A: Fully flat input (matches the flat output)
ResponseErr({ status: 404, reason: 'Not found' })

// Option B: Wrapped input (separates "what I'm passing" from "what the error looks like")
ResponseErr({ props: { status: 404, reason: 'Not found' } })
```

Option A is more ergonomic and consistent — the input shape mirrors the output shape (minus `name` and `message`). Option B adds a layer of indirection that doesn't earn its place.

**Leaning toward**: Option A (fully flat input).

### 3. Should `ReservedKeys` include future fields?

Currently reserved: `name`, `message`. Should we also reserve potential future additions?

Candidates:
- `stack` — if we ever add stack traces
- `timestamp` — if we ever add timestamps
- `code` — common in error systems

**Leaning toward**: Only reserve `name` and `message`. Don't design for hypothetical futures. If we add a field later, we add it to the reserved list at that time.

### 4. How does the `.because()` convenience method change?

Currently, `.because()` exists on factories when context includes `reason: string`. It does `extractErrorMessage(error)` and puts it in `context.reason`. With flat props, the same pattern works — just check if `TProps` includes `reason: string`:

```typescript
// If the error has { reason: string } in its props:
ResponseErr.because(caughtError)
// Equivalent to:
ResponseErr({ status: ???, reason: extractErrorMessage(caughtError) })
```

Problem: `.because()` only fills `reason`. If the error has other required fields (like `status`), `.because()` can't provide them. This was already a problem with the nested design.

Options:
- Remove `.because()` entirely — it's a leaky shortcut
- Keep `.because()` but only allow it when `reason` is the ONLY required prop
- Allow `.because(error, { status: 404 })` — a partial-apply pattern

**Needs decision.**

### 5. Migration path from nested to flat

The granular error migration spec (`20260226T000000-granular-error-migration.md`) already plans to migrate all call sites. That spec assumes nested `context`. If we go flat, the migration target changes:

```typescript
// The existing spec targets:
ResponseErr({ context: { status: 404 } })

// This spec targets:
ResponseErr({ status: 404 })
```

The two specs should be reconciled — this design spec defines the shape, the migration spec defines the rollout.

---

## History / Decision Log

### Why we examined this

The granular error migration work forced a question: if we're touching every error definition and every call site anyway, should we also fix the shape of `TaggedError` itself? The answer was yes — the nested `context` bag and first-class `cause` field were adding complexity without proportional value.

### The namespace collision debate

**Initial position**: Flat spreading is dangerous because context fields could collide with `name` or `message`.

**Resolution**: This is trivially solved at the type level with `ValidProps<T>`. TypeScript rejects collisions at compile time. The collision argument was a lazy justification for the status quo, not a real problem.

```typescript
type ReservedKeys = 'name' | 'message';
type ValidProps<T extends JsonObject> =
  keyof T & ReservedKeys extends never ? T : never;

// This would be a compile error:
createTaggedError('X').withProps<{ name: string }>()  // ← rejected
```

### The cause debate

**Initial position**: `cause` is valuable for error chaining and stack trace preservation.

**Counter-evidence**: Every call site in the codebase does `extractErrorMessage(error)`, destroying the original error. No code walks cause chains. JavaScript already has `Error.cause` (ES2022) for native error chaining. `cause` as a first-class field is ceremony nobody consumes.

**Resolution**: Remove `cause` as a built-in concept. If an error type needs it, it's just another typed field in its props.

### The access pattern comparison

The decisive argument. Side by side:

```typescript
// Nested — current
case 'ResponseError': {
  const { context: { status }, message } = postError;
}

// Flat — proposed
case 'ResponseError': {
  const { status, message } = postError;
}
```

```typescript
// Nested — message template
.withMessage(({ context }) => `HTTP ${context.status}`)

// Flat — message template
.withMessage(({ status }) => `HTTP ${status}`)
```

Flat wins on ergonomics in both consumption and definition. The nested form adds a layer of indirection that nobody benefits from.

---

## What This Spec Does NOT Cover

- **Service-by-service migration**: See `20260226T000000-granular-error-migration.md`
- **The `Result` type (`Ok`/`Err`)**: Unchanged by this work
- **`trySync`/`tryAsync`**: Unchanged by this work
- **The `Err` factory suffix convention** (`ResponseErr` wraps in `{ error, data: null }`): Unchanged

---

## Next Steps

1. Resolve open questions (naming, `.because()`, reserved keys)
2. Implement the new `TaggedError` type and `createTaggedError` builder in wellcrafted
3. Reconcile with the granular error migration spec
4. Migrate all error definitions and call sites
