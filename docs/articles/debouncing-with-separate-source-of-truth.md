# Debouncing Doesn't Lose Data When the Source is Separate

When you debounce writes, you might worry about data loss. What if the timeout gets canceled? What if cleanup runs before the write fires?

The key insight: if your save function always reads from the current source of truth, canceling the timeout is safe. The timeout controls *when* you write, not *what* you write.

## The Pattern

```typescript
let saveTimeout: Timer | null = null;

const debouncedSave = () => {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    save(); // Always reads current state
  }, DEBOUNCE_MS);
};
```

The crucial detail: `save()` reads from the source of truth at call time, not from some captured value.

## Why Canceling is Safe

Consider this cleanup:

```typescript
async function destroy() {
  // Cancel any pending debounced save
  if (saveTimeout) clearTimeout(saveTimeout);

  // Final save to ensure all data is persisted
  await save();
}
```

You might think: "I just canceled a pending save! Did I lose data?"

No. The canceled timeout would have called `save()`, which reads the current state. Your `destroy()` also calls `save()`, which reads the same current state. The data is the same either way.

## Real Example: Y.js Persistence

```typescript
const save = () => Bun.write(filePath, Y.encodeStateAsUpdate(ydoc));

let saveTimeout: Timer | null = null;

const debouncedSave = () => {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    save();
  }, DEBOUNCE_MS);
};

ydoc.on('update', debouncedSave);

async function destroy() {
  if (saveTimeout) clearTimeout(saveTimeout);
  await save(); // Writes the exact same ydoc state
}
```

The `ydoc` is the source of truth. Every call to `save()` encodes its current state. Whether the save happens from the timeout or from `destroy()`, it writes the same data.

## When This Breaks

This only works if your save function reads current state. If you capture the data at debounce time, you lose this guarantee:

```typescript
// BROKEN: Captures state at debounce time
const debouncedSave = (data: Data) => {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    save(data); // Uses old captured data!
  }, DEBOUNCE_MS);
};
```

Now if you cancel and call `save()` with new data, the behaviors differ. The canceled timeout had old data; your new call has new data.

## The Rule

Keep your save function stateless: read from the source of truth at call time, not from captured parameters. Then canceling a debounced save is always safe because the next save will write the same current state.
