# The Value-or-Function Resolution Pattern in TypeScript

TL;DR: Use input-driven type inference to resolve values that can be either a direct value or a factory function, ensuring type safety even with generic data.

See also my response in https://github.com/TanStack/query/pull/9212#issuecomment-3706463498

## The Problem

In many APIs, we want to allow users to provide either a static value or a function that computes that value at runtime. This leads to the repetitive "resolve" pattern scattered throughout the codebase.

```typescript
const result = typeof valueOrFn === 'function' ? valueOrFn(...args) : valueOrFn;
```

While simple for concrete types, this pattern becomes problematic when combined with TypeScript generics.

## The Naive Solution

A common first attempt is to define a union type using a guard to prevent `T` from being a function.

```typescript
type NonFunctionGuard<T> = T extends Function ? never : T;
type ValueOrFn<T> = NonFunctionGuard<T> | ((...args: any[]) => T);

function resolveNaive<T>(input: ValueOrFn<T>): T {
  return typeof input === 'function' ? input() : input;
}
```

This works for concrete types like `string` or `number`, but it fails as soon as you introduce generics.

## The TypeScript Limitation

When working with a generic `TData`, TypeScript cannot determine if `TData` extends `Function` at compile time.

```typescript
function updateData<TData>(input: ValueOrFn<TData>): TData {
  // Error: This expression is not callable.
  // Type 'NonFunctionGuard<TData>' has no call signatures.
  return typeof input === 'function' ? input() : input;
}
```

Because `TData` is opaque, TypeScript treats `input` as a union where one member *might* be a function and the other *might* be something else, but it can't safely narrow it because `NonFunctionGuard<TData>` itself is still unresolved.

## The Solution: Input-driven Type Inference

Instead of trying to constrain a generic `T`, we can infer the return type directly from the *input* type. This is the approach used by libraries like React's `useState`, TanStack Query, and Zustand.

By using a conditional type that extracts the return type of a function or falls back to the type itself, we let TypeScript's inference engine do the heavy lifting.

```typescript
type ResolvedValue<TValueOrFn> = TValueOrFn extends (...args: any[]) => infer R
  ? R
  : TValueOrFn;
```

## The Implementation

The implementation uses function overloads to handle both defined and optional inputs while maintaining the inferred relationship.

```typescript
export function resolveValue<TValueOrFn>(
  valueOrFn: TValueOrFn,
  ...args: any[]
): ResolvedValue<TValueOrFn> {
  return typeof valueOrFn === 'function' ? valueOrFn(...args) : valueOrFn;
}

// Example usage in an API
const initialData: string | (() => string) = 'hello';
const resolved = resolveValue(initialData); // Inferred as string
```

## Usage Examples

### Concrete Types
For standard types, the inference is automatic and seamless.

```typescript
const count: number | (() => number) = 10;
const resolved = resolveValue(count); // number
```

### Generic Types
When dealing with generics, you have two main strategies to satisfy the compiler.

**1. Type Assertion at the Call Site**
If you know the generic won't be a function, you can assert the result.

```typescript
function handleGeneric<TData>(input: TData | (() => TData)): TData {
  return resolveValue(input) as TData;
}
```

**2. Functional Wrappers**
If the data you are handling *could* potentially be a function, always wrap the "value" case in a function.

```typescript
// If TData could be () => void, passing it directly is ambiguous
const AmbiguousValue = () => console.log('I am a function');

// Wrapping ensures it is treated as the value, not the factory
const resolved = resolveValue(() => AmbiguousValue); 
```

## Trade-offs

The "Value-or-Function" pattern is a powerful tool for API flexibility, but it introduces ambiguity if the value itself is meant to be a function. 

- **Use it when**: The expected value is clearly data (objects, primitives, arrays).
- **Avoid it when**: The value being managed is itself a function (like a callback or listener), as the resolution logic will incorrectly execute it.

In ambiguous cases, prefer requiring a functional wrapper `() => T` consistently, rather than supporting the union.
