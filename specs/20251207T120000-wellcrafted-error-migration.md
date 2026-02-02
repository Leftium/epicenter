# Well-Crafted Error Migration Plan

## Overview

This document outlines the migration from the old `createTaggedError` API to the new v0.28.0 fluent API with explicit opt-in for `context` and `cause` properties.

## Key Philosophy Changes

### Before (v0.27.0 and earlier)
All errors had optional `context` and `cause` by default:
```typescript
const { ApiError } = createTaggedError('ApiError');
// ApiError had: { name, message, context?: Record<string, unknown>, cause?: AnyTaggedError }
```

### After (v0.28.0)
Errors only have `{ name, message }` by default. Context and cause must be explicitly added:
```typescript
// Minimal error
const { ApiError } = createTaggedError('ApiError');
// { name, message }

// With context
const { ApiError } = createTaggedError('ApiError')
  .withContext<{ endpoint: string }>();
// { name, message, context: { endpoint: string } }

// With optional cause
const { ApiError } = createTaggedError('ApiError')
  .withCause<NetworkError | undefined>();
// { name, message, cause?: NetworkError }
```

### Cause Philosophy
- `cause` is ONLY for TaggedError chains (Service A wraps Service B error)
- Raw unknown errors from catch blocks should:
  1. Have their message extracted via `extractErrorMessage(error)`
  2. Optionally be stored in `context.originalError` for debugging
- Leaf services (that don't call other TaggedError-returning services) should NOT have a cause property

---

## Audit Results

### Category 1: Pure Leaf Services (No Context, No Cause)

These services don't need context or cause. They should use the simplest form:

| File | Error Type | Current | New |
|------|-----------|---------|-----|
| `services/sound/types.ts` | `PlaySoundServiceError` | flexible | `createTaggedError('PlaySoundServiceError')` |
| `services/recorder/types.ts` | `RecorderServiceError` | flexible | `createTaggedError('RecorderServiceError')` |
| `services/text/types.ts` | `TextServiceError` | flexible | `createTaggedError('TextServiceError')` |
| `services/fs/types.ts` | `FsServiceError` | flexible | `createTaggedError('FsServiceError')` |
| `services/permissions/index.ts` | `PermissionsServiceError` | flexible | `createTaggedError('PermissionsServiceError')` |
| `services/tray.ts` | `SetTrayIconServiceError` | flexible | `createTaggedError('SetTrayIconServiceError')` |
| `services/analytics/types.ts` | `AnalyticsServiceError` | flexible | `createTaggedError('AnalyticsServiceError')` |
| `services/notifications/types.ts` | `NotificationServiceError` | flexible | `createTaggedError('NotificationServiceError')` |
| `services/completion/types.ts` | `CompletionServiceError` | flexible | `createTaggedError('CompletionServiceError')` |
| `services/db/types.ts` | `DbServiceError` | flexible | `createTaggedError('DbServiceError')` |
| `services/global-shortcut-manager.ts` | `InvalidAcceleratorError` | flexible | `createTaggedError('InvalidAcceleratorError')` |
| `services/global-shortcut-manager.ts` | `GlobalShortcutServiceError` | flexible | `createTaggedError('GlobalShortcutServiceError')` |
| `services/device-stream.ts` | `DeviceStreamServiceError` | flexible | `createTaggedError('DeviceStreamServiceError')` |
| `services/http/types.ts` | `ConnectionError` | flexible | `createTaggedError('ConnectionError')` |
| `services/http/types.ts` | `ParseError` | flexible | `createTaggedError('ParseError')` |
| `services/http/types.ts` | `ResponseError` | custom wrapper | Keep as-is (has custom `status` property) |

**Action**: These are already correct for v0.28.0 defaults. No changes needed to declarations. However, usages that pass `cause: error` need fixing.

---

### Category 2: Errors with Structured Context

These need `.withContext<T>()`:

| File | Error Type | Context Type | Migration |
|------|-----------|--------------|-----------|
| `packages/epicenter/src/core/blobs/types.ts` | `BlobError` | `{ filename: string; code: BlobErrorCode }` | `.withContext<BlobContext>()` |
| `packages/epicenter/src/core/db/table-helper.ts` | `RowValidationError` | `{ tableName: string; id: string; errors: ArkErrors; summary: string }` | `.withContext<RowValidationContext>()` |

---

### Category 3: Errors with Both Context and Cause (Error Chains)

These wrap other TaggedErrors and need both `.withContext<T>()` and `.withCause<T | undefined>()`:

| File | Error Type | Wraps | Migration |
|------|-----------|-------|-----------|
| `services/device-stream.ts` | `DeviceStreamServiceError` | Self (chained calls) | `.withCause<DeviceStreamServiceError \| undefined>()` |

---

### Category 4: Incorrect Cause Usages (FIXES NEEDED)

These pass `cause: error` where `error` is `unknown`. They need to be fixed:

#### `services/analytics/web.ts` (line 20)
```typescript
// BEFORE
AnalyticsServiceErr({
  message: 'Failed to log analytics event',
  context: { event },
  cause: error,  // ❌ error is unknown
})

// AFTER
AnalyticsServiceErr({
  message: `Failed to log analytics event: ${extractErrorMessage(error)}`,
})
```

#### `services/analytics/desktop.ts` (line 21)
Same pattern as web.ts.

#### `services/device-stream.ts` (lines 35, 75, 112)
```typescript
// BEFORE
DeviceStreamServiceErr({
  message: '...',
  cause: error,  // ❌ error is unknown
})

// AFTER - for leaf errors (lines 35, 75)
DeviceStreamServiceErr({
  message: `...: ${extractErrorMessage(error)}`,
})

// AFTER - for chained errors (lines 172, 204 - wraps DeviceStreamServiceError)
// These are correct! They wrap TaggedErrors, not unknown errors
```

#### `services/global-shortcut-manager.ts` (lines 57-60, 72-76, 104-112, 127-131)
```typescript
// BEFORE
InvalidAcceleratorErr({
  message: '...',
  context: { accelerator },
  cause: undefined,  // This is fine, but unnecessary
})

GlobalShortcutServiceErr({
  message: `...: ${extractErrorMessage(error)}`,
  context: { accelerator, error },  // ❌ storing raw error in context
  cause: error,  // ❌ error is unknown
})

// AFTER
InvalidAcceleratorErr({
  message: '...',
})  // No context or cause needed

GlobalShortcutServiceErr({
  message: `...: ${extractErrorMessage(error)}`,
})  // extractErrorMessage already captures the error info in the message
```

#### `services/permissions/index.ts` (lines 37-40, 54-58, 75-79, 93-97)
```typescript
// BEFORE
PermissionsServiceErr({
  message: `Failed to check accessibility permissions: ${extractErrorMessage(error)}`,
  cause: error,  // ❌ error is unknown
})

// AFTER
PermissionsServiceErr({
  message: `Failed to check accessibility permissions: ${extractErrorMessage(error)}`,
})  // extractErrorMessage already captures the info
```

#### `services/completion/*.ts`
Multiple files pass `cause: apiError` or `cause: error`. These need review.

---

## Implementation Tasks

### Phase 1: Update Error Declarations (Minimal Impact)

- [ ] Review all `createTaggedError` declarations
- [ ] For errors that need context, add `.withContext<T>()`
- [ ] For errors that wrap other TaggedErrors, add `.withCause<T | undefined>()`
- [ ] Remove `cause: null` and `cause: undefined` from error usages (they're now implicit)

### Phase 2: Fix Incorrect Cause Usages

- [ ] `services/analytics/web.ts` - Remove cause, ensure extractErrorMessage in message
- [ ] `services/analytics/desktop.ts` - Remove cause, ensure extractErrorMessage in message
- [ ] `services/device-stream.ts` - Remove cause from unknown error catches
- [ ] `services/global-shortcut-manager.ts` - Remove cause and context from error constructors
- [ ] `services/permissions/index.ts` - Remove cause from error constructors
- [ ] `services/notifications/web.ts` - Review and fix
- [ ] `services/completion/*.ts` - Review and fix all files

### Phase 3: Update Epicenter Package

- [ ] `packages/epicenter/src/core/blobs/types.ts` - Migrate to fluent API
- [ ] `packages/epicenter/src/core/db/table-helper.ts` - Migrate to fluent API

---

## Review Section

_To be filled after implementation_

---

## Notes

1. The new v0.28.0 defaults are actually simpler for most leaf services
2. The key insight: `cause` chains TaggedErrors, `context` holds debug data
3. Use `extractErrorMessage(error)` to put raw error info in the message string
4. Remove all `cause: error` where `error` is `unknown` from catch blocks
