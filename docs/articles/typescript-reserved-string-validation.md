# Use Branded Error Types for Readable Compile-Time Rejections

**TL;DR**: When rejecting specific string literals at compile time, return a **branded error type instead of `never`** to give developers a readable message in their IDE.

> The Drizzle ORM pattern: make the error type carry the explanation.

## The Problem

You want to prevent certain strings from being used. The naive approach:

```typescript
type Reserved = 'id' | 'createdAt'

type ValidName<T extends string> = T extends Reserved ? never : T

function defineField<T extends string>(name: ValidName<T>) { ... }

defineField('title')  // OK
defineField('id')     // Error: Argument of type '"id"' is not assignable to type 'never'
```

That error message is useless. "Not assignable to never" tells you nothing about why 'id' is forbidden.

## The Drizzle Pattern

Create a branded type that carries the error message:

```typescript
interface FieldError<T extends string> {
  __fieldError: T
}

type Reserved = 'id' | 'createdAt'

type ValidName<T extends string> =
  T extends Reserved
    ? FieldError<`"${T}" is reserved - tables have implicit ID`>
    : T

function defineField<T extends string>(
  name: ValidName<T> extends FieldError<any> ? never : T
) { ... }
```

Now when someone writes `defineField('id')`, hovering over the error shows:

```
ValidName<"id"> = FieldError<'"id" is reserved - tables have implicit ID'>
```

The error message is right there in the type.

## Comparison

| Approach         | Error Message               | Discoverability    |
| ---------------- | --------------------------- | ------------------ |
| Return `never`   | "not assignable to never"   | None               |
| Branded Error    | `FieldError<"reason here">` | Hover shows reason |
| Template Literal | "not assignable to never"   | None               |

## Real Usage

Drizzle ORM uses this for query builder constraints:

```typescript
type SQLiteDeletePrepare<T> = SQLitePreparedQuery<{
	all: T['returning'] extends undefined
		? DrizzleTypeError<'.all() cannot be used without .returning()'>
		: T['returning'][];
}>;
```

When you call `.all()` without `.returning()`, the type resolves to `DrizzleTypeError<'...'>`; you see exactly what's wrong.

## The Pattern

```typescript
// 1. Define the branded error type
interface MyError<T extends string> {
  __error: T
}

// 2. Create a validation type that returns the error
type Validate<T> = T extends Forbidden
  ? MyError<`"${T}" is not allowed because [reason]`>
  : T

// 3. In the function signature, reject the error type
function myFn<T>(value: Validate<T> extends MyError<any> ? never : T) { ... }
```

The key insight: the error type exists only to carry a message. It's never instantiated at runtime. TypeScript's type system becomes your error messaging system.
