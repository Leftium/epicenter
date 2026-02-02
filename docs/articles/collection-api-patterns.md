# Collection API Patterns: Three Approaches

When building collection APIs in TypeScript, you need to decide how users access items by dynamic keys. There are three main approaches, each with distinct trade-offs.

## The Problem

You have a collection of items with dynamic string keys:

```typescript
// Users want to access items
const posts = tables.???('posts');

// You also need utility methods
tables.toJSON();
tables.keys();
tables.has('posts');
```

The challenge: how do you expose both item access and utility methods without namespace collision?

## Approach 1: Dot Syntax (Property Access)

```typescript
tables.posts; // item
tables.toJSON(); // utility
```

**How it works:** Items are properties on the object.

**Pros:**

- Most ergonomic: `tables.posts` is short and natural
- IDE autocomplete shows available tables
- Feels like accessing a regular object

**Cons:**

- **Namespace collision**: What if someone names a table "toJSON" or "keys"?
- Requires reserving method names users can't use
- Dynamic keys need bracket notation: `tables['my-table']`
- TypeScript types become complex with dynamic keys

**Best for:** Fixed, known keys at compile time (like `table.name`, `table.icon`).

## Approach 2: Callable (Function Call)

```typescript
tables('posts'); // item
tables.toJSON(); // utility
```

**How it works:** The collection is a function. Calling it accesses items; properties are utilities.

**Pros:**

- **No namespace collision**: `tables('toJSON')` vs `tables.toJSON()` are unambiguous
- Short syntax for item access
- TypeScript supports callable types well

**Cons:**

- **Less discoverable**: `tables.` doesn't show the main access method
- **Unfamiliar**: No standard library uses this pattern
- **Asymmetric**: Get is callable, but set is `tables.set('key', value)`

**Best for:** When namespace collision is a real concern and you value brevity.

## Approach 3: Explicit `.get()` Method

```typescript
tables.get('posts'); // item
tables.toJSON(); // utility
```

**How it works:** Standard Map-like API with `.get()`, `.set()`, `.has()`, etc.

**Pros:**

- **Discoverable**: `tables.` shows all methods including `get`
- **Familiar**: Same pattern as Map, WeakMap, every ORM, every cache
- **Symmetric**: `.get()`, `.set()`, `.has()`, `.delete()` form a consistent set
- **No namespace collision**: `tables.get('toJSON')` vs `tables.toJSON()` are unambiguous

**Cons:**

- Slightly more verbose: `tables.get('posts')` vs `tables('posts')`

**Best for:** Most cases. The familiarity and discoverability outweigh the slight verbosity.

## Comparison Table

| Aspect                  | Dot Syntax     | Callable          | `.get()`              |
| ----------------------- | -------------- | ----------------- | --------------------- |
| Example                 | `tables.posts` | `tables('posts')` | `tables.get('posts')` |
| Namespace collision     | Yes            | No                | No                    |
| IDE discoverability     | Good           | Poor              | Good                  |
| Familiar pattern        | Yes            | No                | Yes                   |
| Symmetric with `.set()` | No             | No                | Yes                   |
| Verbosity               | Lowest         | Medium            | Medium                |

## Our Recommendation

**Use `.get()` by default.** It's the most balanced choice:

1. Familiar to anyone who's used Map or an ORM
2. Discoverable in IDE autocomplete
3. Consistent with `.set()`, `.has()`, `.delete()`
4. No namespace collision risk

Use **dot syntax** only for fixed, compile-time-known keys like metadata properties (`table.name`, `table.icon`).

Use **callable** only if you have a specific reason and accept the discoverability trade-off.

## Implementation Examples

### Dot Syntax (for fixed keys)

```typescript
type Table = {
	name: string;
	icon: string | null;
	setName(name: string): void;
	setIcon(icon: string | null): void;
};
```

### Callable

```typescript
type TablesCollection = {
	(key: string): Table | undefined;
	has(key: string): boolean;
	keys(): string[];
};

function createTables(): TablesCollection {
	const accessor = (key: string) => store.get(key);
	return Object.assign(accessor, {
		has: (key: string) => store.has(key),
		keys: () => [...store.keys()],
	});
}
```

### Explicit `.get()`

```typescript
type TablesCollection = {
	get(key: string): Table | undefined;
	has(key: string): boolean;
	keys(): string[];
};

function createTables(): TablesCollection {
	return {
		get: (key: string) => store.get(key),
		has: (key: string) => store.has(key),
		keys: () => [...store.keys()],
	};
}
```

## See Also

- [The Callable Collection Pattern](./callable-collection-pattern.md): Deep dive into the callable approach
- [My Journey Through Collection APIs](./collection-api-journey.md): Why we chose `.get()`
- [PR #1275](https://github.com/EpicenterHQ/epicenter/pull/1275): The migration PR with before/after examples
