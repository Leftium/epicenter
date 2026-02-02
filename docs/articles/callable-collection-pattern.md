# The Callable Collection Pattern

The callable collection pattern boils down to a simple insight.

**Instead of:**

```typescript
const posts = tables.get('posts');
```

**You can do:**

```typescript
const posts = tables('posts');
```

That's it. The "magic" is just lifting `.get()` to be the call signature itself. The function IS the getter.

## Implementation

```typescript
const accessor = (key: string) => store.get(key);

return Object.assign(accessor, {
	get: accessor, // Still available if you want it
	has: (key) => store.has(key),
	keys: () => [...store.keys()],
	// ... other utilities
});
```

TypeScript supports this via call signatures:

```typescript
type CallableCollection<T> = {
	(key: string): T | undefined; // Call signature
	get(key: string): T | undefined;
	has(key: string): boolean;
	keys(): string[];
};
```

## Why It Works

The call signature `(key: string): T | undefined` makes the type callable while still allowing properties. `Object.assign` merges the function with an object containing the utility methods.

## The Namespace Collision Benefit

The pattern elegantly solves a real problem: what if a user creates an item with the same name as a utility method?

```typescript
// Problem: is this the "toJSON" item or the toJSON method?
tables.toJSON;

// Solution: call syntax for items, dot syntax for utilities
tables('toJSON'); // item named "toJSON"
tables.toJSON(); // utility method
```

## Trade-offs

**Pros:**

- Eliminates namespace collision entirely
- Shorter syntax: `tables('posts')` vs `tables.get('posts')`
- TypeScript has good support for callable types

**Cons:**

- Less discoverable: typing `tables.` doesn't show the main access method
- Unfamiliar: Map, WeakMap, ORMs all use `.get()`
- Asymmetric: callable for get, but `.set()` for set

## See Also

- [Collection API Patterns](./collection-api-patterns.md): Comparison of all three approaches
- [My Journey Through Collection APIs](./collection-api-journey.md): Why we moved away from this pattern
- [PR #1275](https://github.com/EpicenterHQ/epicenter/pull/1275): The migration PR with before/after examples
