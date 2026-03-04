# idb's README Is the Canonical "Await in Every Method" Example

The most prominent example I can think of for the "store a promise, await it in every method" pattern is [idb](https://github.com/jakearchibald/idb), Jake Archibald's IndexedDB wrapper. It's the very first usage example in the README:

```typescript
import { openDB } from 'idb';

const dbPromise = openDB('keyval-store', 1, {
	upgrade(db) {
		db.createObjectStore('keyval');
	},
});

export async function get(key) {
	return (await dbPromise).get('keyval', key);
}
export async function set(key, val) {
	return (await dbPromise).put('keyval', val, key);
}
export async function del(key) {
	return (await dbPromise).delete('keyval', key);
}
```

`openDB` calls `indexedDB.open()` immediately. The connection starts in the background the moment this module loads. Every exported function awaits the same promise, so the first caller waits for the connection and every subsequent caller gets the already-resolved value for the cost of one microtick.

## Why this works so well for IndexedDB

IndexedDB has two properties that make this pattern natural. First, opening a database is async: it might trigger schema upgrades, wait for other tabs to close old connections, or simply take time to read from disk. You can't make `openDB` synchronous. Second, every operation on the database is also async. So every method already returns a promise; adding one more `await` at the top costs nothing.

```typescript
// Without the pattern: getter function ceremony at every call site
const db = await getDb();
const result = await db.get('store', key);

// With the pattern: one-liner, db access is internal
const result = await get(key);
```

The consumer never touches the database connection. They call `get(key)` and get a value back. The connection management is an implementation detail that the promise encapsulates completely.

## How we use it in our blob store

Our IndexedDB blob store follows the same shape. Construction is synchronous; every method awaits the connection promise internally:

```typescript
export function createIndexedDbBlobStore({ dbName, storeName }): BlobStore {
	const dbPromise = openDB(dbName, 1, {
		upgrade(db) {
			if (!db.objectStoreNames.contains(storeName)) {
				db.createObjectStore(storeName, { keyPath: 'id' });
			}
		},
	});

	return {
		async get(id) {
			const db = await dbPromise;
			const record = await db.get(storeName, id);
			if (!record) return null;
			return { blob: new Blob([record.arrayBuffer], { type: record.mimeType }), mimeType: record.mimeType };
		},
		async put(id, blob, mimeType) {
			const db = await dbPromise;
			const arrayBuffer = await blob.arrayBuffer();
			await db.put(storeName, { id, arrayBuffer, mimeType });
		},
		// ...
	};
}
```

The returned `BlobStore` object is synchronously constructed and can be passed around, stored in a variable, even exported from a module. The async database connection is invisible to consumers.

## The relationship to sync construction with `whenReady`

This is a sibling of the [sync construction, async property pattern](./sync-construction-async-property-ui-render-gate-pattern.md). Both solve the same problem: async initialization that you don't want to leak into every consumer. The difference is where you wait.

| Pattern | Where you wait | Good for |
|---|---|---|
| `whenReady` at root | Once, in the UI layout | Clients with mix of sync and async methods |
| Await in every method | Implicitly, in each method | Purely async APIs like database access |

idb's pattern works because every IndexedDB operation is already async. There's no sync method that would need the connection to be ready before it runs. If your client has sync methods that depend on initialized state, the `whenReady` pattern is the better fit. If every method is async anyway, hiding the `await` inside each method is simpler and means consumers don't need to think about readiness at all.
