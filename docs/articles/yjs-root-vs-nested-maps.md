# Yjs Root Types vs Nested Types: The One Rule You Need

Here's the single most important thing to understand about Yjs data modeling:

```
doc.getMap('x')              →  Returns THE shared map named 'x'
map.set('x', new Y.Map())    →  Assigns A NEW object to key 'x'
```

Root types are **looked up by name** (same name = same object).  
Nested assignments are **values written to a key** (concurrent writes = one wins).

## The Bug This Causes

Two clients both create a nested map at the same key:

```typescript
// Client A
users.set('alice', new Y.Map([['role', 'admin']]));

// Client B (concurrent, before sync)
users.set('alice', new Y.Map([['role', 'editor']]));
```

After sync:

```
users (Y.Map)
└─ "alice" →  [Map A or Map B, not both]

Result: the losing map and everything inside it is gone.
```

One Y.Map wins. The other is dropped entirely, including all its nested data.

## Why Root Types Are Different

```typescript
const a = doc.getMap('users');
const b = doc.getMap('users');

a === b; // true - same object
```

`doc.getMap('users')` means "the map named `users` for this doc." Every client that calls it gets the same shared object. Edits inside it merge.

```
doc
└─ "users" → Y.Map (singleton, same across all clients)
```

## Why Nested Assignments Can Collide

```typescript
users.set('alice', new Y.Map());
```

This means "assign this specific Y.Map instance to the key `alice`." If two clients do this before syncing, there are two different objects competing for one key. Yjs picks one deterministically; the other is lost.

**The false-safe pattern:**

```typescript
// Looks safe, but still races across clients:
if (!users.has('alice')) {
	users.set('alice', new Y.Map());
}
```

Both clients can pass the check before either syncs. The race still happens.

## When Nested Assignment Is Safe

**Editing inside an existing nested type is always safe:**

```typescript
const alice = users.get('alice');
alice.set('role', 'admin'); // ✅ Merges with other edits
```

**Using collision-free IDs is safe:**

```typescript
const id = crypto.randomUUID();
users.set(id, new Y.Map([['name', 'alice']])); // ✅ No one else uses this ID
```

The danger is only **concurrent creation of a new shared type at the same key**.

## What To Do About It

If multiple clients might create the same key concurrently, don't assign a fresh shared type to that key. Use IDs instead of names, or restructure your data.

For detailed solutions, see [The Nested Y.Map Trap](./yjs-nested-maps-lww-trap.md).

## Try It Yourself

Copy this into a file and run with `bun` or `tsx` to see the behavior:

```typescript
import * as Y from 'yjs';

// Simulate two clients syncing
const sync = (a: Y.Doc, b: Y.Doc) => {
	Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
};

const docA = new Y.Doc();
const docB = new Y.Doc();

// Both clients create "posts" with different data BEFORE syncing
docA.getMap('tables').set('posts', new Y.Map([['from', 'A']]));
docB.getMap('tables').set('posts', new Y.Map([['from', 'B']]));

console.log('Before sync:');
console.log('  A:', docA.getMap('tables').get('posts')?.toJSON()); // { from: 'A' }
console.log('  B:', docB.getMap('tables').get('posts')?.toJSON()); // { from: 'B' }

sync(docA, docB);

console.log('After sync:');
console.log('  A:', docA.getMap('tables').get('posts')?.toJSON()); // One of them
console.log('  B:', docB.getMap('tables').get('posts')?.toJSON()); // Same as A
// One client's data is gone!
```

## TL;DR

- `doc.getMap('name')` → singleton by name, always safe
- `map.set('key', new Y.Map())` → value assignment, can collide
- Edits inside existing types → safe
- Concurrent creation at same key → one wins, other dropped

---

_See also:_

- [The Nested Y.Map Trap](./yjs-nested-maps-lww-trap.md) - When this causes data loss and how to fix it
- [The Surprising Truth About LWW in CRDTs](./crdt-last-write-wins-surprise.md) - How Yjs decides which value wins
