# Store the Promise, Not the Value

When an async operation might outlive its call site, store the promise, not just the result. Your future cleanup code will thank you.

You might instinctively want to store the result of an async operation:

```typescript
let lastSavedId: string | null = null;

async function save(data: Data) {
  const result = await writeToFile(data);
  lastSavedId = result.id;
}
```

This looks clean. You have a variable that holds the actual value you care about. But there's a subtle problem: during cleanup, you have no way to know if a write is currently in-flight.

## The Race Condition

Consider this cleanup function:

```typescript
async function destroy() {
  // Do final cleanup
  await finalSave();
}
```

What happens if a write is still in progress when `destroy()` is called? You might:

1. Start `finalSave()` while the previous write is still running
2. Have two concurrent writes to the same file
3. Corrupt data or lose the in-flight write entirely

The problem: `lastSavedId` only tells you what finished saving, not what's currently saving.

## The Fix: Store the Promise Itself

```typescript
let writeInProgress: Promise<SaveResult> | null = null;

async function save(data: Data) {
  writeInProgress = writeToFile(data);
  await writeInProgress;
  writeInProgress = null;
}

async function destroy() {
  // Wait for any in-flight write to complete first
  await writeInProgress;

  // Now it's safe to do final cleanup
  await finalSave();
}
```

By storing the promise, you can await it during cleanup. The in-flight operation completes, then your cleanup runs.

## Real Example: Debounced Persistence

Here's where this pattern really matters. When you debounce writes, there's a gap between when the timeout fires and when the write completes:

```typescript
let saveTimeout: Timer | null = null;
let writeInProgress: Promise<number> | null = null;

const debouncedSave = () => {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    writeInProgress = save(); // Fire and don't await
  }, DEBOUNCE_MS);
};

async function destroy() {
  // Cancel any pending debounced save
  if (saveTimeout) clearTimeout(saveTimeout);

  // Wait for any in-progress write to complete
  await writeInProgress;

  // Final save to ensure all data is persisted
  await save();
}
```

The debounced save fires without awaiting (fire-and-forget). But we store the promise so cleanup can wait for it. Without this, `destroy()` might run while a write is still happening, leading to data loss.

## When You Need This Pattern

Use promise tracking when:

1. You have fire-and-forget async operations (debounced saves, background syncs)
2. You have a cleanup/destroy function that needs to wait for in-flight work
3. You're worried about concurrent operations on the same resource

If you're always awaiting your async operations inline, you probably don't need this. The pattern matters when there's a time gap between starting an operation and needing to know it's done.

## The Rule

When an async operation might outlive its call site, store the promise, not just the result. Your future cleanup code will thank you.
