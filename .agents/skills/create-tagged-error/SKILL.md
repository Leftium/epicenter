---
name: create-tagged-error
description: How to define and use defineErrors from wellcrafted. Use when creating new error types, updating error definitions, or reviewing error patterns. Covers variant factories, extractErrorMessage for cause, InferErrors/InferError for types, and call site patterns.
metadata:
  author: epicenter
  version: '2.0'
---

# defineErrors

## Import

```typescript
import {
  defineErrors,
  extractErrorMessage,
  type InferErrors,
  type InferError,
} from 'wellcrafted/error';
```

## Core Rules

1. All variants for a service live in **one `defineErrors` call** — never spread them across multiple calls
2. The factory function **returns `{ message, ...fields }`** — that is the entire API; no `.withMessage()`, `.withContext()`, or `.withCause()` chains
3. **`cause: unknown`** is just a field like any other — accept it in the input and forward it in the return object
4. **Call `extractErrorMessage(cause)` inside the factory**, never at the call site
5. Each call like `MyError.Variant({ ... })` **returns `Err(...)` automatically** — no separate `FooErr` pair
6. **Shadow the const with a same-name type** using `InferErrors` — `const FooError` / `type FooError`
7. Use `InferError<typeof FooError.Variant>` to extract a single variant's type when needed
8. Aim for 2–5 variants per service, each named by failure mode

## Patterns

### 1. Simple variant — no input, static message

```typescript
export const RecorderError = defineErrors({
  AlreadyRecording: () => ({
    message: 'A recording is already in progress',
  }),
});
export type RecorderError = InferErrors<typeof RecorderError>;

// Call site
return RecorderError.AlreadyRecording();
```

### 2. Variant with structured fields — message computed from input

```typescript
export const DbError = defineErrors({
  NotFound: ({ table, id }: { table: string; id: string }) => ({
    message: `${table} '${id}' not found`,
    table,
    id,
  }),
});
export type DbError = InferErrors<typeof DbError>;

// Call site
return DbError.NotFound({ table: 'users', id: '123' });
// error.message → "users '123' not found"
// error.table   → "users"
// error.id      → "123"
```

### 3. Variant with cause — extractErrorMessage inside the factory

```typescript
import { extractErrorMessage } from 'wellcrafted/error';

export const FfmpegError = defineErrors({
  Service: ({ operation, cause }: { operation: string; cause: unknown }) => ({
    message: `Failed to ${operation}: ${extractErrorMessage(cause)}`,
    operation,
    cause,
  }),
});
export type FfmpegError = InferErrors<typeof FfmpegError>;

// Call site — pass the raw caught error, never call extractErrorMessage here
catch: (error) => FfmpegError.Service({ operation: 'compress audio', cause: error }),
```

### 4. Multiple variants in one object — discriminated union built-in

```typescript
export const DeviceStreamError = defineErrors({
  PermissionDenied: ({ cause }: { cause: unknown }) => ({
    message: `Microphone permission denied. ${extractErrorMessage(cause)}`,
    cause,
  }),
  DeviceConnectionFailed: ({
    deviceId,
    cause,
  }: {
    deviceId: string;
    cause: unknown;
  }) => ({
    message: `Unable to connect to device '${deviceId}'. ${extractErrorMessage(cause)}`,
    deviceId,
    cause,
  }),
  NoDevicesFound: () => ({
    message: "No microphones found. Check your connections and try again.",
  }),
});
export type DeviceStreamError = InferErrors<typeof DeviceStreamError>;
// DeviceStreamError is automatically the union of all three variants

// Extracting a single variant type
type NoDevicesFoundError = InferError<typeof DeviceStreamError.NoDevicesFound>;
```

### 5. Simple service error — pass-through message from caller

```typescript
export const RecorderError = defineErrors({
  Service: ({ message }: { message: string }) => ({ message }),
});
export type RecorderError = InferErrors<typeof RecorderError>;

// Call site
return RecorderError.Service({ message: 'Already recording.' });
```

## Type Extraction

```typescript
// Full union type for all variants
type MyServiceError = InferErrors<typeof MyServiceError>;

// Single variant type
type NotFoundError = InferError<typeof MyServiceError.NotFound>;
```

## Anti-Patterns

```typescript
// WRONG — old createTaggedError API
import { createTaggedError } from 'wellcrafted/error';
const { FooError, FooErr } = createTaggedError('FooError')
  .withContext<{ id: string }>()
  .withMessage(({ context }) => `Not found: ${context.id}`);

// WRONG — calling extractErrorMessage at the call site
catch: (error) => MyError.Failed({ message: extractErrorMessage(error) });
// CORRECT — pass raw cause, call extractErrorMessage inside the factory
catch: (error) => MyError.Failed({ cause: error });

// WRONG — one defineErrors per variant (defeats the namespace grouping)
const BusyError = defineErrors({ BusyError: () => ({ message: 'Busy' }) });
const PermError = defineErrors({ PermError: () => ({ message: 'No perm' }) });
// CORRECT — all variants for a service in one call
const RecorderError = defineErrors({
  Busy: () => ({ message: 'A recording is already in progress' }),
  PermissionDenied: () => ({ message: 'Microphone permission denied' }),
});

// WRONG — using ReturnType instead of InferErrors
type FooError = ReturnType<typeof FooError>;
// CORRECT
type FooError = InferErrors<typeof FooError>;

// WRONG — using separate Err/FooErr pair (old API)
FooErr({ context: { id: '1' } });
// CORRECT — each variant call returns Err(...) automatically
FooError.NotFound({ id: '1' });

// WRONG — monolithic single-variant error for a service with many failure modes
const RecorderError = defineErrors({
  Error: ({ message }: { message: string }) => ({ message }), // Too vague
});
// CORRECT — split by failure mode
const RecorderError = defineErrors({
  AlreadyRecording: () => ({ message: 'A recording is already in progress' }),
  PermissionDenied: ({ cause }: { cause: unknown }) => ({
    message: `Microphone permission denied. ${extractErrorMessage(cause)}`,
    cause,
  }),
  DeviceNotFound: ({ deviceId }: { deviceId: string }) => ({
    message: `Device not found: ${deviceId}`,
    deviceId,
  }),
});
```
