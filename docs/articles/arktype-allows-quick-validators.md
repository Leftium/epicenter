2025-11-14T09:35:56.389Z

# Arktype's `.allows()`: Quick Type-Safe Validators

I was refactoring validation code and hit this pattern that's been a game-changer for spinning up quick validators. It's arktype's `.allows()` method, and it completely eliminates the need for manual type predicates.

## The Problem

You're writing a validation function. Data comes in as `unknown`. You need to check if it's an object before doing anything with it.

The old way:

```typescript
function validateData(data: unknown) {
  // Manual type guard
  if (!isPlainObject(data)) {
    return { error: 'not an object' };
  }

  // Now data is Record<string, unknown>... but you had to write isPlainObject
  const field = data.someField;
}

// And you need to maintain this:
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null &&
    typeof value === 'object' &&
    Object.prototype.toString.call(value) === '[object Object]';
}
```

That's a lot of ceremony just to check "is this a plain object?"

## The Solution

Arktype's `.allows()` gives you a type predicate for free:

```typescript
function validateData(data: unknown) {
  if (!type("Record<string, unknown>").allows(data)) {
    return { error: 'not an object' };
  }

  // TypeScript automatically knows data is Record<string, unknown>
  const field = data.someField; // ✅ No type assertion needed
}
```

That's it. No manual type guard. No type assertion. Just works.

## Why This Matters

When you return early with `.allows()`, TypeScript's control flow analysis automatically narrows the type for everything after. This means:

1. **No type assertions**: You don't need `data as Record<string, unknown>`
2. **No manual predicates**: You don't need to write `is Record<string, unknown>` functions
3. **Type safety**: If the check fails, you return early. If it passes, TypeScript knows the type

Here's what happens under the hood:

```typescript
if (!type("Record<string, unknown>").allows(data)) {
  return; // Early exit if validation fails
}

// After this point, TypeScript knows:
// data is Record<string, unknown>
```

This is the pattern TypeScript calls "type narrowing via control flow analysis." Arktype just makes it effortless.

## Real-World Example

Here's actual code from a validation function:

```typescript
validateUnknown(data: unknown): SerializedRowValidationResult<TSchema> {
  // Step 1: Check if it's a plain object
  if (!type("Record<string, unknown>").allows(data)) {
    return {
      status: 'invalid-structure',
      row: data,
      reason: {
        type: 'not-an-object',
        actual: data,
      },
    };
  }

  // Step 2: Check if all values are SerializedCellValue
  for (const [fieldName, value] of Object.entries(data)) {
    // TypeScript knows data is Record<string, unknown> here
    if (!isSerializedCellValue(value)) {
      return {
        status: 'invalid-structure',
        row: data,
        reason: {
          type: 'invalid-cell-value',
          field: fieldName,
          actual: value,
        },
      };
    }
  }

  // Step 3: Now we can safely cast to our specific type
  const serializedRow = data as SerializedRow;
  // ... validate against schema
}
```

Notice: No manual type guard for the first check. The `.allows()` call handles both validation and type narrowing.

## Common Patterns

### Checking for Plain Objects

This is the most common use case:

```typescript
if (!type("Record<string, unknown>").allows(data)) {
  return { error: 'Expected an object' };
}
// data is now Record<string, unknown>
```

### Checking Arrays

```typescript
if (!type("unknown[]").allows(data)) {
  return { error: 'Expected an array' };
}
// data is now unknown[]
```

### Checking Specific Shapes

```typescript
if (!type({ id: "string", name: "string" }).allows(data)) {
  return { error: 'Expected {id: string, name: string}' };
}
// data is now { id: string; name: string }
```

## When to Use `.allows()` vs Other Methods

Arktype gives you three ways to validate:

1. **`.allows(data)`**: Quick type check with type narrowing. Use for structural validation.
2. **`schema(data)`**: Full validation that returns `data | ArkErrors`. Use when you need detailed errors.
3. **`.validate(data)`**: Returns `[data, undefined] | [undefined, ArkErrors]`. Similar to `.safeParse()` in Zod.

For quick "is this the right shape?" checks at the start of functions, `.allows()` is perfect. It's fast, the intent is clear, and TypeScript narrows the type automatically.

## Comparison with Zod

If you've used Zod, you might write:

```typescript
const schema = z.record(z.unknown());
const result = schema.safeParse(data);
if (!result.success) {
  return { error: result.error };
}
const validated = result.data; // Type is Record<string, unknown>
```

With arktype's `.allows()`:

```typescript
if (!type("Record<string, unknown>").allows(data)) {
  return { error: 'not an object' };
}
// data is already narrowed to Record<string, unknown>
```

Less indirection. No result object to destructure. The type narrowing happens in place.

## The Favorite: `Record<string, unknown>`

This one comes up constantly:

```typescript
type("Record<string, unknown>").allows(data)
```

It answers the question: "Is this a plain JavaScript object that I can iterate over safely?"

Not an array. Not a Date. Not a class instance. Just a plain object with string keys.

I use this at the start of almost every validation function. It's the first line of defense before doing any property access.

## Performance Note

Creating `type("Record<string, unknown>")` on every call would be wasteful, but arktype caches compiled types internally. So this:

```typescript
if (!type("Record<string, unknown>").allows(data)) {
  // ...
}
```

Doesn't recompile the type each time. The first call compiles it, subsequent calls reuse the cached version.

## The Lesson

When you need a quick validator with automatic type narrowing, reach for `.allows()`. Especially `type("Record<string, unknown>").allows(data)`.

It eliminates an entire category of boilerplate: manual type guards. You get type safety without the ceremony.
