---
name: create-tagged-error
description: How to define and use createTaggedError from wellcrafted. Use when creating new error types, updating error definitions, or reviewing error patterns. Covers withMessage (required terminal step), withContext, withCause, discriminated unions, and call site patterns.
metadata:
  author: epicenter
  version: '1.0'
---

# createTaggedError

## Import

```typescript
import { createTaggedError } from 'wellcrafted/error';
```

## Core Rules

1. `.withMessage(fn)` is **always required** — you cannot get factories without it
2. `.withMessage(fn)` is **always last** — nothing chains after it
3. `.withContext()` and `.withCause()` can appear in any order before `.withMessage()`
4. Factory input: provide `context`/`cause`, **not** `message` (message is auto-computed)
5. `message` is an optional override at call sites only
6. Context must be `JsonObject` — no `Date`, `Error` instances, functions, or class instances
7. Split monolithic errors into discriminated unions — 2–5 errors per service, each named by failure mode
8. Use `ReturnType<typeof FooError>` to extract the type

## Patterns

### 1. Simple error — static message

```typescript
const { RecorderBusyError, RecorderBusyErr } = createTaggedError('RecorderBusyError')
  .withMessage(() => 'A recording is already in progress');

RecorderBusyErr({});
type RecorderBusyError = ReturnType<typeof RecorderBusyError>;
```

### 2. Error with context — message computed from structured data

```typescript
const { DbNotFoundError, DbNotFoundErr } = createTaggedError('DbNotFoundError')
  .withContext<{ table: string; id: string }>()
  .withMessage(({ context }) => `${context.table} '${context.id}' not found`);

DbNotFoundErr({ context: { table: 'users', id: '123' } });
// error.message → "users '123' not found"
type DbNotFoundError = ReturnType<typeof DbNotFoundError>;
```

### 3. Error with optional context

```typescript
const { LogError, LogErr } = createTaggedError('LogError')
  .withContext<{ file: string; line: number } | undefined>()
  .withMessage(({ context }) =>
    context ? `Parse failed at ${context.file}:${context.line}` : 'Parse failed'
  );

LogErr({});
LogErr({ context: { file: 'app.ts', line: 42 } });
type LogError = ReturnType<typeof LogError>;
```

### 4. Error with cause

```typescript
const { ServiceError, ServiceErr } = createTaggedError('ServiceError')
  .withContext<{ operation: string }>()
  .withCause<DbNotFoundError | undefined>()
  .withMessage(({ context, cause }) =>
    cause
      ? `Operation '${context.operation}' failed: ${cause.message}`
      : `Operation '${context.operation}' failed`
  );

type ServiceError = ReturnType<typeof ServiceError>;
```

### 5. Message override at call site (one-off cases)

```typescript
DbNotFoundErr({
  message: 'The recording you are looking for has been deleted',
  context: { table: 'recordings', id: '123' },
});
```

## Discriminated Unions

Prefer specific, named errors over one monolithic error per service. Aim for 2–5 errors per service, each named by failure mode.

```typescript
const { RecorderBusyError, RecorderBusyErr } = createTaggedError('RecorderBusyError')
  .withMessage(() => 'A recording is already in progress');

const { RecorderPermissionError, RecorderPermissionErr } = createTaggedError('RecorderPermissionError')
  .withContext<{ device: string }>()
  .withMessage(({ context }) => `Microphone permission denied for ${context.device}`);

const { RecorderDeviceError, RecorderDeviceErr } = createTaggedError('RecorderDeviceError')
  .withContext<{ deviceId: string }>()
  .withMessage(({ context }) => `Failed to acquire stream from device '${context.deviceId}'`);

type RecorderServiceError = RecorderBusyError | RecorderPermissionError | RecorderDeviceError;
```

## Anti-Patterns

```typescript
// WRONG — missing .withMessage()
const { FooError } = createTaggedError('FooError'); // TS error!

// WRONG — message as primary factory input (old API)
FooErr({ message: 'Something failed' });

// WRONG — chaining after .withMessage()
createTaggedError('FooError').withMessage(() => 'x').withContext<{}>(); // TS error

// WRONG — Date in context (not JSON-serializable)
.withContext<{ createdAt: Date }>()

// WRONG — monolithic error
const { RecorderServiceError } = createTaggedError('RecorderServiceError')
  .withMessage(() => 'Recorder error'); // Too vague — split by failure mode

// CORRECT — always extract type via ReturnType
type DbNotFoundError = ReturnType<typeof DbNotFoundError>;
```
