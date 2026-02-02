# Promise Chaining for Sequential Async Operations

When you need multiple async operations to run sequentially without blocking the caller, chain them through a single promise variable.

You might instinctively reach for a mutex or lock:

```typescript
let isWriting = false;

async function save(data: Data) {
  while (isWriting) {
    await sleep(10); // Poll until free
  }
  isWriting = true;
  await writeToFile(data);
  isWriting = false;
}
```

This works, but it's clunky. You're busy-waiting, and the caller has to await the entire operation. What if you want synchronous API calls that queue up async work in the background?

## The Pattern: Chain Promises with `.then()`

```typescript
let writeQueue: Promise<void> = Promise.resolve();

function queueWrite(operation: () => Promise<void>): void {
  writeQueue = writeQueue.then(operation).catch((error) => {
    console.error('Write failed:', error);
  });
}
```

That's it. Each call to `queueWrite()` appends an operation to the chain. Operations run sequentially, but the caller returns immediately.

## Why This Works

When you call `writeQueue.then(operation)`, you get back a new promise that:

1. Waits for the current `writeQueue` to resolve
2. Then runs your `operation`
3. Then resolves when `operation` completes

By assigning this back to `writeQueue`, the next call will wait for everything before it. The chain grows automatically.

## Real Example: Background Disk Persistence

Here's a diagnostics manager that updates an in-memory map instantly, then queues disk writes in the background:

```typescript
function createDiagnosticsManager() {
  const diagnosticsMap = new Map<string, DiagnosticEntry>();
  let writeQueue: Promise<void> = Promise.resolve();

  async function writeToDisk(): Promise<void> {
    const data = Object.fromEntries(diagnosticsMap);
    await Bun.write(diagnosticsPath, JSON.stringify(data, null, 2));
  }

  function queueWrite(operation: () => Promise<void>): void {
    writeQueue = writeQueue.then(operation).catch((error) => {
      console.error('Queued write failed:', error);
    });
  }

  return {
    add(entry: DiagnosticEntry) {
      // Synchronous: update in-memory map immediately
      diagnosticsMap.set(entry.filePath, entry);

      // Asynchronous: queue disk write in background
      queueWrite(() => writeToDisk());
    },

    remove(filePath: string) {
      diagnosticsMap.delete(filePath);
      queueWrite(() => writeToDisk());
    },

    flush() {
      // Return the queue so callers can await all pending writes
      return writeQueue;
    },
  };
}
```

The API is synchronous: `add()` and `remove()` return immediately. But disk writes happen sequentially in the background, never stepping on each other.

## The Flush Pattern

Notice the `flush()` method returns `writeQueue`. This lets callers await all pending operations:

```typescript
const diagnostics = createDiagnosticsManager();

diagnostics.add({ filePath: '/foo.ts', error: 'Type error' });
diagnostics.add({ filePath: '/bar.ts', error: 'Syntax error' });
diagnostics.remove('/foo.ts');

// Wait for all queued writes to complete
await diagnostics.flush();
```

Without `flush()`, you'd have no way to know when the background work finishes. This is essential for cleanup and testing.

## Error Handling

The `.catch()` in `queueWrite()` is critical. Without it, a single failed operation would reject the entire chain, and subsequent operations would never run.

```typescript
writeQueue = writeQueue
  .then(operation)
  .catch((error) => {
    // Log but don't rethrow - keeps the chain alive
    console.error('Write failed:', error);
  });
```

Each operation is isolated. One failure doesn't block the rest.

## When You Need This Pattern

Use promise chaining when:

1. You want a synchronous API that triggers background async work
2. Multiple operations must not run concurrently (writes to the same file)
3. You need a way to "flush" or await all pending work

If your operations can run concurrently, just use `Promise.all()`. This pattern is specifically for sequential execution with a non-blocking API.

## The Rule

When you need sequential async operations with a synchronous caller interface, chain promises through a single variable and provide a `flush()` method for cleanup.
