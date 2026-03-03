# Your TypeScript Errors Don't Have to Suck

**TL;DR**: When your generic function has a constraint users commonly miss, add a fallback overload with a string literal parameter to show a clear error message. Zero type depth overhead, works with any schema library, and your users will actually understand what went wrong.

---

I was building the `defineTable()` API for Epicenter — a function that takes a schema and registers it as a versioned table. The constraint is simple: the schema output must include `id: string` and `_v: number`. We call this `BaseRow`.

When a user forgets those fields, they need to know exactly what to add. What they got instead looked like this:

```
Argument of type 'Type<{ title: string; }, {}>' is not assignable to
parameter of type 'CombinedStandardSchema<BaseRow>'.
  Type 'Type<{ title: string; }, {}>' is not assignable to type
  '{ "~standard": StandardSchemaV1.Props<BaseRow, BaseRow> &
  StandardJSONSchemaV1.Props<BaseRow, BaseRow>; }'.
    Types of property '"~standard"' are incompatible.
      ... [15 more lines of structural diff]
```

Nobody reads that. Nobody can act on it.

This is a solvable problem.

---

## The Structural Diff Problem

`defineTable()` accepts any schema satisfying `CombinedStandardSchema<BaseRow>` — meaning the schema output must extend `{ id: string; _v: number } & JsonObject`. When the output doesn't match, TypeScript explains why `StandardSchemaV1.Props<{ title: string }, { title: string }>` is not assignable to `StandardSchemaV1.Props<BaseRow, BaseRow>`. That explanation is not for humans.

```typescript
// ❌ Fails with an incomprehensible structural diff
const posts = defineTable(
  type({ title: "string", content: "string" })
  //    ^ Missing 'id: string' and '_v: number'
);

// ✅ This works
const posts = defineTable(
  type({ id: "string", title: "string", content: "string", _v: "1" })
);
```

The gap between the error message and the fix is enormous.

---

## The Classic Fix: Conditional Type Branding

The standard pattern is conditional type branding. Write a helper type that resolves to either `T` or a descriptive string literal:

```typescript
type ValidateTableSchema<T extends CombinedStandardSchema> =
  StandardSchemaV1.InferOutput<T> extends BaseRow
    ? T
    : "defineTable() error: Schema must include 'id: string' and '_v: number' fields.";

export function defineTable<TSchema extends CombinedStandardSchema>(
  schema: ValidateTableSchema<TSchema>,
): TableDefinitionWithDocBuilder<[TSchema & CombinedStandardSchema<BaseRow>], Record<string, never>>;
```

When the check fails, the error becomes:

```
Argument of type 'Type<{ title: string; }>' is not assignable to
parameter of type '"defineTable() error: Schema must include 'id: string' and '_v: number' fields."'
```

Readable. Actionable. The user sees exactly what to add.

### The Problem: TS2589

We tried this. Every call site broke:

```
error TS2589: Type instantiation is excessively deep and possibly infinite.
```

ArkType's type machinery is already deep. `CombinedStandardSchema` wraps two standard schema specs. Adding a conditional type that inspects the inferred output, then intersects the result back into the return type, compounds the instantiation depth multiplicatively. TypeScript gave up before it could evaluate a single call.

---

## The Fix That Actually Shipped: Fallback Overload

The insight: TypeScript tries overloads in order. Add a catch-all overload at the end with a string literal parameter. Users only hit it when all the valid overloads have already failed — and that last failure shows your message.

Here is exactly what we shipped in Epicenter's `define-table.ts`:

```typescript
// Overload 1: Single schema (happy path)
export function defineTable<TSchema extends CombinedStandardSchema<BaseRow>>(
  schema: TSchema,
): TableDefinitionWithDocBuilder<[TSchema], Record<string, never>>;

// Overload 2: Multiple schemas for versioned migrations (happy path)
export function defineTable<
  const TVersions extends [
    CombinedStandardSchema<BaseRow>,
    CombinedStandardSchema<BaseRow>,
    ...CombinedStandardSchema<BaseRow>[],
  ],
>(
  ...versions: TVersions
): {
  migrate(
    fn: (row: StandardSchemaV1.InferOutput<TVersions[number]>) =>
      StandardSchemaV1.InferOutput<LastSchema<TVersions>>,
  ): TableDefinitionWithDocBuilder<TVersions, Record<string, never>>;
};

// Overload 3: Fallback — fires when the valid overloads don't match
export function defineTable(
  schema: "defineTable() error: Each schema must output BaseRow ({ id: string; _v: number } & JsonObject). Add 'id: string' and '_v: number' to your schema.",
  ...rest: unknown[]
): never;

// Implementation signature — TypeScript never calls this directly
export function defineTable(...args: unknown[]): unknown {
  // ...runtime logic
}
```

When a user passes a schema missing `id` and `_v`:

```
No overload matches this call.
  Overload 1 of 3: ...
    Argument of type 'Type<{ title: string; }>' is not assignable to
    parameter of type 'CombinedStandardSchema<BaseRow>'.
      [structural diff]

  Overload 2 of 3: ...
    [structural diff]

  Overload 3 of 3: ...
    Argument of type 'Type<{ title: string; }>' is not assignable to
    parameter of type '"defineTable() error: Each schema must output
    BaseRow ({ id: string; _v: number } & JsonObject). Add 'id: string'
    and '_v: number' to your schema."'
```

Your eye goes straight to the last error. The fix is spelled out.

---

## Why This Works

The fallback overload adds zero type instantiation depth. There is no conditional type, no intersection. The parameter is just a plain string literal. TypeScript checks "is this value assignable to this exact string?" — the answer is no, it reports the mismatch, done.

```
┌──────────────────────────────────────────────────────────┐
│  TypeScript tries overloads in order                     │
│                                                          │
│  Overload 1: CombinedStandardSchema<BaseRow>  ← fails   │
│  Overload 2: CombinedStandardSchema<BaseRow>  ← fails   │
│  Overload 3: "defineTable() error: ..."       ← fails   │
│                                                          │
│  "No overload matches this call"                         │
│  Three errors listed. Last one is yours.                 │
└──────────────────────────────────────────────────────────┘
```

The valid overloads above are completely untouched. Their generics, constraints, return types — all exactly as they were. You are adding a new last resort, not changing anything that works.

The implementation signature at the bottom is never evaluated by TypeScript for callers. TypeScript only tries the declared overloads. The implementation just satisfies the compiler that a concrete function exists.

---

## The Same Pattern in `defineKv()`

We applied the same approach to `defineKv()`, which requires JSON-serializable output:

```typescript
// Happy path overloads...
export function defineKv<TSchema extends CombinedStandardSchema<JsonValue>>(
  schema: TSchema,
): KvDefinition<[TSchema]>;

// ... variadic overload ...

// Fallback
export function defineKv(
  schema: "defineKv() error: Schema output must be JSON-serializable (extend JsonValue). Ensure all field values are strings, numbers, booleans, null, arrays, or plain objects.",
  ...rest: unknown[]
): never;
```

Same structure, different message. Four lines of code, every user who hits that constraint gets a clear path forward.

---

## Trade-offs: When to Use Which

| | Conditional Type Branding | Fallback Overload |
|---|---|---|
| Errors shown | Single clean message | Multiple + yours at the end |
| Type instantiation depth | Adds depth (can trigger TS2589) | Zero overhead |
| Works with ArkType / Zod / deep schemas | Risky | Yes |
| Original overloads changed | Yes | No |
| Inference risk | Higher | None |

**Use conditional type branding when** your types are shallow, you have verified it does not trigger TS2589, and you want exactly one error message.

**Use fallback overloads when** you are working with ArkType, Zod, StandardSchema, or any library that already uses significant type depth — or when you want zero risk of breaking inference.

One honest note: fallback overloads produce three errors, not one. The useful message is last. Editors that collapse "No overload matches" errors may hide it by default. In practice, developers expand the error and scroll to the last item — but if your audience might give up after seeing three errors, conditional branding (when it works) is cleaner.

---

## The Pattern Generalized

You can use this anywhere you have a function with a constraint that produces useless structural diffs:

```typescript
// Happy path overloads
export function myFunction<T extends ComplexConstraint>(value: T): ReturnType;
export function myFunction<const T extends AnotherCase>(value: T): OtherReturn;

// Fallback — add this right before the implementation
export function myFunction(
  value: "myFunction() error: [explain exactly what's wrong and how to fix it]",
  ...rest: unknown[]
): never;

export function myFunction(...args: unknown[]): unknown {
  // implementation
}
```

Three rules for writing the error message string:

1. **Name the function.** Users might be calling several similar functions.
2. **State the constraint violated.** Not the TypeScript type — the human concept.
3. **Tell them how to fix it.** "Add `id: string` and `_v: number`" beats "must extend BaseRow".

---

## The Golden Rule

Keep the error message in the code that enforces the constraint. Not in a README. Not in a comment. In the type itself, where TypeScript will surface it automatically at the exact moment someone gets it wrong.

The fallback overload pattern costs you four lines of code and gives every user who hits that constraint a clear path forward. That is one of the best return-on-investment moves in API design.
