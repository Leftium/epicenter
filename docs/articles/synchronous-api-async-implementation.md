# Synchronous API, Async Implementation

Sometimes you want callers to get instant feedback while slow operations happen in the background. The pattern: update an in-memory data structure immediately, then queue async work to persist it.

## The Problem

```typescript
async function addDiagnostic(entry: DiagnosticEntry) {
  await writeToDisk(entry); // Caller waits for disk I/O
}
```

The caller blocks on disk I/O. If they're adding many entries in a loop, each one waits for the previous write to complete.

## The Pattern

```typescript
const diagnosticsMap = new Map<string, DiagnosticEntry>();

function addDiagnostic(entry: DiagnosticEntry) {
  // Synchronous: update in-memory immediately
  diagnosticsMap.set(entry.filePath, entry);

  // Asynchronous: queue disk write in background
  queueWrite(() => writeToDisk());
}
```

The function returns immediately. The caller sees the updated state in the map. Disk persistence happens later, in the background.

## Why Two Data Structures?

You have two representations of the same data:

1. **In-memory (source of truth for reads)**: Fast, always up-to-date
2. **On-disk (durability)**: Slow, eventually consistent

Reads hit the in-memory structure. Writes update in-memory first, then queue disk persistence.

## Real Example: Diagnostics Manager

```typescript
function createDiagnosticsManager() {
  const diagnosticsMap = new Map<string, DiagnosticEntry>();
  let writeQueue: Promise<void> = Promise.resolve();

  async function writeToDisk(): Promise<void> {
    const data = Object.fromEntries(diagnosticsMap);
    await Bun.write(diagnosticsPath, JSON.stringify(data, null, 2));
  }

  function queueWrite(operation: () => Promise<void>): void {
    writeQueue = writeQueue.then(operation).catch(console.error);
  }

  return {
    add(entry: DiagnosticEntry) {
      // Instant feedback
      diagnosticsMap.set(entry.filePath, entry);
      // Background persistence
      queueWrite(() => writeToDisk());
    },

    remove(filePath: string) {
      diagnosticsMap.delete(filePath);
      queueWrite(() => writeToDisk());
    },

    get(filePath: string) {
      // Fast: reads from memory
      return diagnosticsMap.get(filePath);
    },

    getAll() {
      return Array.from(diagnosticsMap.values());
    },

    flush() {
      // Wait for all pending writes
      return writeQueue;
    },
  };
}
```

`add()`, `remove()`, `get()`, and `getAll()` are all synchronous. The disk is only touched in the background.

## The Flush Method

You need a way for callers to wait for background work to complete:

```typescript
const diagnostics = createDiagnosticsManager();

diagnostics.add({ filePath: '/foo.ts', error: 'Type error' });
diagnostics.add({ filePath: '/bar.ts', error: 'Syntax error' });

// Fast: reads from memory immediately
console.log(diagnostics.getAll()); // Shows both entries

// Wait for disk persistence before shutdown
await diagnostics.flush();
```

Without `flush()`, you can't guarantee data reached disk before process exit.

## Trade-offs

**Pros:**
- Callers never block on I/O
- Reads are instant
- Multiple writes batch naturally

**Cons:**
- Data can be lost if process crashes before flush
- Slightly more complex implementation
- Need to call `flush()` at cleanup time

## When to Use This Pattern

Use it when:
- Writes happen frequently (logging, diagnostics, analytics)
- Reads need to be fast
- Temporary data loss is acceptable (can be reconstructed)

Don't use it when:
- Data must be durable immediately (financial transactions)
- The async overhead matters more than I/O latency

## The Rule

For high-frequency, non-critical writes: update memory synchronously, persist asynchronously, and provide a `flush()` for cleanup.
