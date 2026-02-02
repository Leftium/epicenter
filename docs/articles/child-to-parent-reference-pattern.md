# Child-to-Parent Reference Pattern

When you create an object that "owns" another object, a common pattern is for the child to hold a reference back to its parent. This feels backwards at first - you're indexing into the child to access the parent - but it's powerful and idiomatic in JavaScript/TypeScript.

## The Pattern

```typescript
class Parent {
  children: Child[] = [];

  createChild(): Child {
    const child = new Child(this);
    this.children.push(child);
    return child;
  }
}

class Child {
  readonly parent: Parent;

  constructor(parent: Parent) {
    this.parent = parent;
  }

  doSomethingWithParent(): void {
    // Access parent through the child
    this.parent.someMethod();
  }
}
```

## Why It Feels Weird

The mental model that trips people up:

```typescript
const parent = new Parent();
const child = parent.createChild();

// This feels backwards:
child.parent.someMethod();

// You're going "down" into child, then "up" to parent
// Shouldn't you just use parent directly?
```

## Why It Works: Pass-by-Reference

JavaScript passes objects by reference, not by value. When you write `this.parent = parent`, you're not copying the parent - you're storing a pointer to the exact same object.

```typescript
const parent = new Parent();
const child = parent.createChild();

// These are the SAME object:
console.log(child.parent === parent); // true

// Mutations through either reference affect the same object:
parent.name = "updated";
console.log(child.parent.name); // "updated"
```

## When This Pattern Shines

The pattern becomes essential when:

1. **You only have the child in scope** - You're in a function that received a child, but needs to access the parent's context:

```typescript
function processChild(child: Child): void {
  // No parent parameter, but we can access it:
  child.parent.transact(() => {
    // ...
  });
}
```

2. **The child is passed around** - Through callbacks, event handlers, or stored in collections where the parent reference would otherwise be lost.

3. **Self-contained APIs** - The child carries everything it needs, reducing function parameter counts.

## Real-World Example: Yjs

Yjs uses this pattern extensively. Every shared type (Y.Array, Y.Map, Y.Text) holds a `.doc` reference to its parent Y.Doc:

```typescript
const ydoc = new Y.Doc();
const yarray = ydoc.getArray('items');

// yarray.doc === ydoc (same object)
yarray.doc.transact(() => {
  yarray.push(['item']);
});
```

See: [Yjs Shared Types Have a .doc Property](./yjs-shared-types-doc-property.md)

## The Tradeoff

This creates a bidirectional relationship (parent knows children, children know parent), which can complicate garbage collection if you're not careful. In most applications this isn't a problem, but be aware that as long as you hold a reference to a child, the parent (and all its other children) won't be garbage collected.
