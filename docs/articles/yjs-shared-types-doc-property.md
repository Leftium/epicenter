# Yjs Shared Types Have a .doc Property

Every Yjs shared type (Y.Array, Y.Map, Y.Text, Y.XmlFragment, etc.) exposes a `.doc` property that references the parent Y.Doc it belongs to. This is an instance of the [child-to-parent reference pattern](./child-to-parent-reference-pattern.md).

## How It Works

When you create or retrieve a shared type from a Y.Doc, Yjs stores a back-reference:

```typescript
import * as Y from 'yjs';

const ydoc = new Y.Doc();
const yarray = ydoc.getArray('items');
const ymap = ydoc.getMap('settings');
const ytext = ydoc.getText('content');

// All shared types reference the same parent doc:
console.log(yarray.doc === ydoc); // true
console.log(ymap.doc === ydoc);   // true
console.log(ytext.doc === ydoc);  // true
```

## When .doc Is Useful

### 1. Transactions from Any Shared Type

You can start a transaction from any shared type without needing the doc in scope:

```typescript
function updateArray(yarray: Y.Array<string>): void {
  // Access the doc through the array:
  yarray.doc.transact(() => {
    yarray.push(['a']);
    yarray.push(['b']);
    yarray.push(['c']);
  });
}
```

### 2. Wrapper Classes

When building abstractions over Yjs, the wrapper only needs to store the shared type:

```typescript
class YKeyValue<T> {
  readonly yarray: Y.Array<{ key: string; val: T }>;
  readonly doc: Y.Doc;

  constructor(yarray: Y.Array<{ key: string; val: T }>) {
    this.yarray = yarray;
    this.doc = yarray.doc as Y.Doc; // Store for convenience
  }

  set(key: string, val: T): void {
    this.doc.transact(() => {
      // Find and remove old entry, push new one
      // ...
    });
  }
}
```

### 3. Cross-Type Operations

When you need to modify multiple shared types atomically:

```typescript
function moveItem(
  source: Y.Array<Item>,
  target: Y.Array<Item>,
  index: number
): void {
  // Both arrays must belong to the same doc
  source.doc.transact(() => {
    const item = source.get(index);
    source.delete(index);
    target.push([item]);
  });
}
```

## The .doc Property Is Initially Null

A shared type's `.doc` is `null` until it's integrated into a Y.Doc. This happens automatically when you use `doc.getArray()`, `doc.getMap()`, etc. But if you create a shared type standalone, it starts unattached:

```typescript
const standaloneArray = new Y.Array();
console.log(standaloneArray.doc); // null

const ydoc = new Y.Doc();
const attachedArray = ydoc.getArray('items');
console.log(attachedArray.doc); // Y.Doc instance
```

## Same Object, Different Access Path

This is pass-by-reference in action. `yarray.doc` and `ydoc` point to the exact same object in memory:

```typescript
const ydoc = new Y.Doc();
const yarray = ydoc.getArray('items');

// These are equivalent:
ydoc.transact(() => { /* ... */ });
yarray.doc.transact(() => { /* ... */ });

// No preference - use whichever you have in scope
```

See: [Child-to-Parent Reference Pattern](./child-to-parent-reference-pattern.md) for the general TypeScript pattern behind this.
