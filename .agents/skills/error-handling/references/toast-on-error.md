# Toast-on-Error Patterns

How to surface errors to users via toast notifications across the monorepo.

## The `toastOnError` Passthrough

`toastOnError` from `@epicenter/ui/sonner` is a passthrough function inspired by Rust's `inspect_err`. It shows a toast and returns the input unchanged—so you can slot it into `return` statements or `.then()` chains without disrupting control flow.

It accepts either a `Result<T, AnyTaggedError>` or a bare `AnyTaggedError`.

- **Title** (bold headline): provided at the call site—this is UI copy, not a service concern.
- **Description** (muted text below): always `error.message` from the tagged error, shown automatically.

```typescript
import { toastOnError } from '@epicenter/ui/sonner';
```

## Preferred Pattern: Destructure First, Then Toast-and-Return

Always destructure the Result first, then use `toastOnError` in the error guard. Never mix `.then()` with `await` on the same expression.

```typescript
// ✅ GOOD — destructure, then one-liner error guard
const { data, error } = await api.billing.portal();
if (error) return toastOnError(error, 'Could not open billing portal');
if (data.url) window.location.href = data.url;

// ❌ BAD — mixing .then() with await
const { data, error } = await api.billing.portal().then(r => toastOnError(r, '...'));
```

## Fire-and-Forget Pattern

For onclick handlers where you don't need the result, use `.then()`:

```typescript
// ✅ Fire-and-forget — no await, no destructuring
bookmarkState.toggle(tab).then((r) => toastOnError(r, 'Failed to toggle bookmark'));
savedTabState.save(tab).then((r) => toastOnError(r, 'Failed to save tab'));
```

## When NOT to Use `toastOnError`

### Catch blocks with `unknown` errors

`toastOnError` requires `AnyTaggedError` (from `defineErrors`). Raw `catch (err)` blocks have `unknown` errors—use `extractErrorMessage` instead:

```typescript
import { extractErrorMessage } from 'wellcrafted/error';

// ✅ catch blocks — use extractErrorMessage
try {
    await riskyOperation();
} catch (err) {
    toast.error('Operation failed', { description: extractErrorMessage(err) });
}

// ✅ tryAsync catch handlers — same pattern
await tryAsync({
    try: () => someOperation(),
    catch: (error) => {
        toast.error('Failed', { description: extractErrorMessage(error) });
        return Ok(undefined);
    },
});
```

### TanStack Query `onError` callbacks

Errors from mutation rejection may not be tagged errors. Use `extractErrorMessage`:

```typescript
// ✅ TanStack onError — extractErrorMessage for unknown error types
topUp.mutate(url, {
    onError: (error) => toast.error('Top-up failed', {
        description: extractErrorMessage(error),
    }),
});
```

### Toasts with extra options (actions, custom duration)

`toastOnError` only sets `title` + `description`. If you need `action`, `duration`, or other Sonner options, call `toast.error()` directly:

```typescript
// ✅ Needs action button — use toast.error directly
if (error) {
    toast.error('Failed to open accessibility settings', {
        description: error.message,
        action: {
            label: 'Open Settings',
            onClick: () => openSystemSettings(),
        },
    });
}
```

## Decision Table

| Situation | Pattern |
|---|---|
| Result with tagged error, need to handle data | `if (error) return toastOnError(error, 'title')` |
| Result, fire-and-forget | `.then((r) => toastOnError(r, 'title'))` |
| `catch` block, `unknown` error | `toast.error('title', { description: extractErrorMessage(err) })` |
| TanStack `onError` callback | `toast.error('title', { description: extractErrorMessage(error) })` |
| Toast needs action/duration/id | `toast.error('title', { description: error.message, action: ... })` |
